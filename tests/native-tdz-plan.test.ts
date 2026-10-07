import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import {
	lowerNativeFunctionStorage,
	validateNativeStorage,
} from "../src/compiler/target/lower-native-storage.ts";
import { createConservativeNativePlan } from "../src/compiler/target/program-image.ts";
import type {
	NativeFunctionPlan,
	VmRegisterRepresentation,
} from "../src/compiler/target/program-image.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import type { BytecodeInstruction } from "../src/compiler/target/runtime-image.ts";

const ROTATION = `function rotate(left, right, count) {
	for (let index = 0; index < count; index++) {
		const saved = left; left = right; right = saved;
	}
	return left + right;
}
globalThis.rotate = rotate;
globalThis.result = rotate(3, 7, 4);`;

function compile(source = ROTATION, profile = false) {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(source, "/native-tdz.js"),
		{ profile },
	);
}

function primitiveContract(representation: VmRegisterRepresentation, profile = false) {
	const template = compile().native.functions[1]!.body;
	const producer: BytecodeInstruction =
		representation === "boxed"
			? { opcode: "CREATE_EMPTY", dst: 0 }
			: representation === "string"
				? { opcode: "CREATE_STRING", dst: 0, stringIndex: 0 }
				: representation === "boolean"
					? { opcode: "CREATE_BOOLEAN", dst: 0, value: true }
					: { opcode: "CREATE_NUMBER", dst: 0, value: 7 };
	const instructions: Array<BytecodeInstruction> = [
		producer,
		{ opcode: "JUMP", targetIp: 2 },
		{ opcode: "THROW_IF_TDZ", src: 0, nameStringIndex: 0 },
		{ opcode: "RETURN", value: 0 },
	];
	const body = {
		...template,
		parameterCount: 0,
		registerCount: 1,
		instructions,
		positions: instructions.map(() => -1),
		gcSafepoints: undefined,
		...(profile ? { profileSiteIds: [10, 11, 12, 13] } : {}),
	};
	const native = createConservativeNativePlan([body]).functions[0]!;
	const roots = representation === "boxed" || representation === "string" ? [0] : [];
	return lowerNativeFunctionStorage({
		...native,
		gc: {
			safepoints: native.gc.safepoints.map((point) => ({
				...point,
				rootRegisters: roots,
				incomingRootRegisters: roots,
				outgoingRootRegisters: roots,
			})),
		},
		storageValues: [0],
		registerRepresentations: [representation],
	});
}

describe("native TDZ emission plans", () => {
	it("selects typed scalar omissions while retaining canonical boxed guards and semantic bodies", () => {
		const image = compile();
		const fn = image.native.functions[1]!;
		const entry = fn.directEntries.find((entry) =>
			entry.parameterRepresentations.every((rep) => rep === "number"),
		)!;
		expect(entry.storage!.elidedTdzIps.length).toBeGreaterThan(0);
		expect(fn.storage!.elidedTdzIps).toEqual([]);
		for (const ip of entry.storage!.elidedTdzIps) {
			const op = fn.body.instructions[ip]!;
			expect(op.opcode).toBe("THROW_IF_TDZ");
			if (op.opcode !== "THROW_IF_TDZ") throw new Error("Missing semantic TDZ guard");
			expect(fn.registerRepresentations[op.src]).toBe("boxed");
			expect(entry.registerRepresentations[op.src]).toBe("number");
		}
		expect(
			image.runtime.functions[1]!.instructions.some((op) => op.opcode === "THROW_IF_TDZ"),
		).toBe(true);
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		expect(restored.native.functions[1]!.body).toEqual(fn.body);
		expect(restored.native.functions[1]!.directEntries[entry.id]!.gc).toEqual(entry.gc);
		expect(restored.native.functions[1]!.directEntries[entry.id]!.storage).toEqual(
			entry.storage,
		);
		const emitted = emitCompiledFunction(restored.native.functions[1]!, 1, "", false)!;
		expect(emitted.source).toContain("mal_vm_op_throw_if_tdz");
		const typed = emitted.directEntries.find(
			(candidate) => candidate.id === entry.id && !candidate.leaf,
		)!;
		expect(typed.source).not.toContain("mal_vm_op_throw_if_tdz");
	});

	it.each(["number", "int32", "boolean"] as const)(
		"omits %s checks while preserving jump labels and profile execution events",
		(representation) => {
			const native = primitiveContract(representation, true);
			const ip = native.body.instructions.findIndex((op) => op.opcode === "THROW_IF_TDZ");
			expect(native.storage!.elidedTdzIps).toContain(ip);
			const emitted = emitCompiledFunction(native, 0, "", true)!;
			expect(emitted.emittedInstructions.has(ip)).toBe(true);
			expect(emitted.source).toContain(`L${ip}:;`);
			expect(emitted.source).toContain(
				`MAL_PROFILE_SITE_EVENT(vm, ${native.body.profileSiteIds![ip]}, MAL_PROFILE_SITE_EXECUTION, 1)`,
			);
			expect(emitted.source).not.toContain("mal_vm_op_throw_if_tdz");
			const invalid: NativeFunctionPlan = {
				...native,
				storage: { ...native.storage!, elidedTdzIps: [ip, ip] },
			};
			expect(() => validateNativeStorage(invalid)).toThrow(
				/invalid or stale storage plan/,
			);
		},
	);

	it.each(["boxed", "string"] as const)(
		"retains %s guards and rejects a forged omission",
		(representation) => {
			const native = primitiveContract(representation);
			const ip = native.body.instructions.findIndex((op) => op.opcode === "THROW_IF_TDZ");
			expect(native.storage!.elidedTdzIps).toEqual([]);
			expect(emitCompiledFunction(native, 0, "", false)!.source).toContain(
				"mal_vm_op_throw_if_tdz",
			);
			expect(() =>
				validateNativeStorage({
					...native,
					storage: { ...native.storage!, elidedTdzIps: [ip] },
				}),
			).toThrow(/invalid or stale storage plan/);
		},
	);

	it("rejects stale opcode selections, invalid IPs, and cross-entry omissions at the artifact boundary", () => {
		const image = compile();
		const fn = image.native.functions[1]!;
		const ips = fn.directEntries[0]!.storage!.elidedTdzIps;
		const nonGuard = fn.body.instructions.findIndex((op) => op.opcode !== "THROW_IF_TDZ");
		for (const selected of [ips, [nonGuard], [-1], [fn.body.instructions.length]]) {
			expect(() =>
				serializeCompilerArtifact({
					...image,
					native: {
						...image.native,
						functions: image.native.functions.with(1, {
							...fn,
							storage: { ...fn.storage!, elidedTdzIps: selected },
						}),
					},
				}),
			).toThrow(/invalid or stale storage plan/);
		}
	});

	it("retains scalar TDZ checks for values borrowed by selected numeric-fusion regions", () => {
		const image = compile(`function project(value, left, right, count) {
			const a = value.left; const b = value.right;
			const total = a + b * 2;
			for (let i = 0; i < count; i++) {
				const saved = left; left = right; right = saved;
			}
			return total + left + right;
		}
		globalThis.project = project; globalThis.result = project({left: 3, right: 7}, 3, 7, 4);`);
		const fn = image.native.functions[1]!;
		expect(fn.body.instructions.some((op) => op.opcode === "LOAD_PROPERTY_STATIC")).toBe(
			true,
		);
		for (const storage of [fn.storage, ...fn.directEntries.map((entry) => entry.storage)])
			expect(storage!.elidedTdzIps).toEqual([]);
		expect(
			fn.directEntries.some((entry) =>
				fn.body.instructions.some(
					(op) =>
						op.opcode === "THROW_IF_TDZ" &&
						["number", "int32", "boolean"].includes(
							entry.registerRepresentations[op.src]!,
						),
				),
			),
		).toBe(true);
		expect(emitCompiledFunction(fn, 1, "", false)!.source).toContain(
			"mal_vm_property_try_load_static_number_pair",
		);
	});
});
