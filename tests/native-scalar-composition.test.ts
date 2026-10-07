import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { validateNativeStorage } from "../src/compiler/target/lower-native-storage.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import {
	vmExceptionHandlerTargets,
	vmInstructionReadRegisters,
	vmInstructionWriteRegisters,
} from "../src/compiler/target/runtime-image.ts";

function compile(body: string) {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`globalThis.compose = function compose(value, left, right, callback) { ${body} };`,
			"/scalar-composition.js",
		),
	);
}

describe("native scalar plans around opaque and exceptional windows", () => {
	it("composes an unrelated numeric tail with a real selected fusion region", () => {
		const image = compile(`
			const fused = value.a + value.b * 2;
			callback(fused);
			const a = +left;
			const b = +right;
			const difference = a - b;
			return difference < a;
		`);
		const fn = image.native.functions[1]!;
		const fusion = fn.specializations.find((region) => region.kind === "numeric-fusion")!;
		expect(fusion).toBeDefined();
		const storage = fn.storage!;
		expect(storage.expressionIps.length).toBeGreaterThan(0);
		expect(storage.definitionInitializedRegisters.length).toBeGreaterThan(0);
		for (const ip of [...storage.expressionIps, ...storage.elidedTdzIps])
			expect(fusion.claimedIps).not.toContain(ip);
		const borrowed = fusion.claimedIps.flatMap((ip) => [
			...vmInstructionReadRegisters(fn.body.instructions[ip]!),
			...vmInstructionWriteRegisters(fn.body.instructions[ip]!),
		]);
		for (const register of borrowed)
			expect(storage.definitionInitializedRegisters).not.toContain(register);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
		expect(emitCompiledFunction(fn, fn.functionIndex, "", false)).not.toBeNull();
	});

	it("omits scalar TDZ guards outside a selected property fusion in a typed entry", () => {
		const image = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function project(value, left, right, count, callback) {
					const total = value.left + value.right * 2;
					callback(total);
					for (let i = 0; i < count; i++) {
						const saved = left; left = right; right = saved;
					}
					return left - right;
				}
				globalThis.project = project;
				globalThis.result = project({left: 3, right: 7}, 3, 7, 4, (n) => n);`,
				"/scalar-tdz-composition.js",
			),
		);
		const fn = image.native.functions[1]!;
		expect(fn.specializations.some((region) => region.kind === "numeric-fusion")).toBe(
			true,
		);
		const entry = fn.directEntries.find((candidate) =>
			candidate.parameterRepresentations.slice(1, 4).every((rep) => rep === "number"),
		)!;
		expect(entry.storage!.elidedTdzIps.length).toBeGreaterThan(0);
		const claimed = fn.specializations.flatMap((region) => region.claimedIps);
		for (const ip of entry.storage!.elidedTdzIps) {
			expect(fn.body.instructions[ip]!.opcode).toBe("THROW_IF_TDZ");
			expect(claimed).not.toContain(ip);
		}
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		expect(restored.native.functions[1]!.storage).toEqual(fn.storage);
		expect(
			restored.native.functions[1]!.directEntries.map((candidate) => candidate.storage),
		).toEqual(fn.directEntries.map((candidate) => candidate.storage));
		expect(
			emitCompiledFunction(restored.native.functions[1]!, fn.functionIndex, "", false),
		).not.toBeNull();
	});

	it("admits an unprotected numeric tail while preserving protected producers and catch transport", () => {
		const image = compile(`
			let result;
			try {
				const protectedValue = +left;
				callback(protectedValue);
				result = protectedValue;
			} catch (error) {
				result = callback(error);
			}
			const a = +left;
			const b = +result;
			const difference = a - b;
			return difference < a;
		`);
		const fn = image.native.functions[1]!;
		expect(fn.body.handlers.length).toBeGreaterThan(0);
		const handlers = vmExceptionHandlerTargets(
			fn.body.instructions.length,
			fn.body.handlers,
		);
		const storage = fn.storage!;
		expect(storage.expressionIps.length).toBeGreaterThan(0);
		expect(storage.definitionInitializedRegisters.length).toBeGreaterThan(0);
		expect(storage.rematerializedConstantIps).toEqual([]);
		for (const ip of [...storage.expressionIps, ...storage.elidedTdzIps])
			expect(handlers[ip]).toBeUndefined();
		const protectedDefinition = fn.body.instructions.findIndex(
			(op, ip) => handlers[ip] !== undefined && op.opcode === "UNARY",
		);
		expect(protectedDefinition).toBeGreaterThanOrEqual(0);
		const protectedRegister = vmInstructionWriteRegisters(
			fn.body.instructions[protectedDefinition]!,
		)[0]!;
		expect(storage.definitionInitializedRegisters).not.toContain(protectedRegister);
		expect(() =>
			validateNativeStorage({
				...fn,
				storage: {
					...storage,
					definitionInitializedRegisters: [
						...storage.definitionInitializedRegisters,
						protectedRegister,
					],
				},
			}),
		).toThrow(/invalid or stale storage plan/);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
	});
});
