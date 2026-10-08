import { describe, expect, it } from "vitest";
import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_STRING,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import {
	lowerNativeFunctionStorage,
	validateNativeStorage,
} from "../src/compiler/target/lower-native-storage.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

function storedOperator(expression: string, profile = false) {
	const out = inspectStaticValueFunction(
		`let saved;function compute(left,right,gate){const a=+left,b=+right;const value=${expression};saved=value;gate();return value;}globalThis.compute=compute;`,
		"compute",
		{ profile },
	);
	const store = out.native.body.instructions.find((op) => op.opcode === "STORE_GLOBAL")!;
	if (store.opcode !== "STORE_GLOBAL") throw new Error("Missing escaping store");
	const ip = out.native.body.instructions.findIndex(
		(op) => "dst" in op && op.dst === store.src,
	);
	const op = out.native.body.instructions[ip]!;
	if (op.opcode !== "UNARY" && op.opcode !== "BINARY")
		throw new Error("Missing stored operator");
	return { ...out, ip, op };
}

describe("untraced boxed operator storage", () => {
	it.each(["a*b", "a/b", "a%b", "a>>>b", "a<<b", "a<b", "a===b", "!a", "-a", "~a"])(
		"keeps %s materialized across a call without a shadow root",
		(expression) => {
			const out = storedOperator(expression);
			expect(out.native.registerRepresentations[out.op.dst]).toBe("boxed");
			const gate = out.native.body.instructions.findIndex((op) => op.opcode === "CALL");
			expect(
				out.native.gc.safepoints.some(
					(point) =>
						point.instructionIp === gate &&
						point.incomingRootRegisters.includes(out.op.dst),
				),
			).toBe(true);
			expect(out.native.storage!.expressionIps).not.toContain(out.ip);
			expect(out.native.storage!.rootRegisters).not.toContain(out.op.dst);
			expect(out.c.source).toContain(`MalValue r${out.op.dst};`);
			expect(out.c.source).toContain(`r${out.op.dst} = MAL_VALUE_UNDEFINED;`);
			expect(out.c.source).toMatch(
				new RegExp(
					`r${out.op.dst} = (?:mal_ops_number_value|mal_value_new_boolean|mal_value_from_i32)\\(`,
				),
			);
			expect(out.c.source).not.toContain(`#define r${out.op.dst} (`);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
				out.image,
			);
		},
	);

	it("preserves operator profiling while omitting its immediate result root", () => {
		const out = storedOperator("a*b", true);
		expect(out.native.storage!.expressionIps).toEqual([]);
		expect(out.native.storage!.rootRegisters).not.toContain(out.op.dst);
		expect(out.c.source).toContain("MAL_PROFILE_SITE_EXECUTION");
	});

	it("requires real SSA storage identity for the exclusion", () => {
		const out = storedOperator("a*b");
		const raw = lowerNativeFunctionStorage({ ...out.native, storageValues: undefined });
		expect(raw.storage!.rootRegisters).toContain(out.op.dst);
		expect(() => validateNativeStorage({ ...raw, storage: out.native.storage })).toThrow(
			/invalid or stale storage plan/,
		);
	});

	it("restores a traced local when an operator's operand proof admits heap values", () => {
		const out = storedOperator("a*b");
		const instructions = out.native.instructions.map((plan, ip) =>
			ip === out.ip
				? {
						kind: "exact-operator-input-kinds" as const,
						inputKindMasks: [
							COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_STRING,
							COMPILER_VALUE_KIND_NUMBER,
						] as const,
					}
				: plan,
		);
		const reps = out.native.registerRepresentations.map((rep, local) =>
			local === (out.op.opcode === "BINARY" ? out.op.left : out.op.src)
				? ("boxed" as const)
				: rep,
		);
		const native = lowerNativeFunctionStorage({
			...out.native,
			instructions,
			registerRepresentations: reps,
		});
		expect(native.storage!.rootRegisters).toContain(out.op.dst);
		expect(() =>
			validateNativeStorage({ ...native, storage: out.native.storage }),
		).toThrow(/invalid or stale storage plan/);
	});

	it("retains roots when another writer can replace the proven result with a heap value", () => {
		const out = storedOperator("a*b");
		const instructions = out.native.body.instructions.map((op) =>
			op.opcode === "STORE_GLOBAL"
				? { opcode: "MOVE" as const, dst: out.op.dst, src: 0 }
				: op,
		);
		const native = lowerNativeFunctionStorage({
			...out.native,
			body: { ...out.native.body, instructions },
		});
		expect(native.storage!.rootRegisters).toContain(out.op.dst);
		expect(() =>
			validateNativeStorage({ ...native, storage: out.native.storage }),
		).toThrow(/invalid or stale storage plan/);
	});

	it.each(["a+b", "a*b", "a&b"])(
		"retains generic %s results that can be strings or BigInts",
		(expression) => {
			const out = inspectStaticValueFunction(
				`function compute(a,b,gate){const value=${expression};gate();return value;}globalThis.compute=compute;`,
				"compute",
			);
			const op = out.native.body.instructions.find((op) => op.opcode === "BINARY")!;
			if (op.opcode !== "BINARY") throw new Error("Missing generic operator");
			expect(out.native.storage!.rootRegisters).toContain(op.dst);
		},
	);

	it("preserves suspended operator locals and their boxed snapshot contract", () => {
		const out = inspectStaticValueFunction(
			"let saved;async function compute(left,right,gate){const a=+left,b=+right;const value=a*b;saved=value;await gate;return value;}globalThis.compute=compute;",
			"compute",
		);
		const op = out.native.body.instructions.find(
			(op) => op.opcode === "BINARY" && op.operator === "*",
		)!;
		if (op.opcode !== "BINARY") throw new Error("Missing suspended product");
		expect(out.native.registerRepresentations[op.dst]).toBe("boxed");
		expect(out.native.storage!.rootRegisters).toContain(op.dst);
		expect(
			out.native.storage!.suspension!.points.some((point) =>
				point.registers.includes(op.dst),
			),
		).toBe(true);
	});

	it("retains protected operator storage borrowed by exception transport", () => {
		const out = inspectStaticValueFunction(
			"let saved;function compute(left,right,gate){try{const a=+left,b=+right;const value=a*b;saved=value;gate();return value;}catch(error){return error;}}globalThis.compute=compute;",
			"compute",
		);
		const op = out.native.body.instructions.find(
			(op) => op.opcode === "BINARY" && op.operator === "*",
		)!;
		if (op.opcode !== "BINARY") throw new Error("Missing protected product");
		expect(out.native.storage!.rootRegisters).toContain(op.dst);
	});
});
