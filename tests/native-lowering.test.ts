import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { optimizeSemanticProgramToCore } from "../src/compiler/pipeline/compile-core-common.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { emitProgramImage } from "../src/compiler/target/emit-program-image.ts";
import { lowerCoreCompilationToExecutionProgram } from "../src/compiler/target/lower-execution.ts";
import { lowerExecutionToProgramImage } from "../src/compiler/target/lower-native-program-image.ts";
import { lowerCoreCompilationToNativeProgram } from "../src/compiler/target/lower-native.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";

const source = `
function calculate(value) {
 const first = value + 1;
 globalThis.observe(first);
 const second = value + 2;
 globalThis.observe(second);
 return value + 3;
}
globalThis.calculate = calculate;
`;

describe("SSA native lowering", () => {
	it("preserves wide root mask storage through property-region fallbacks", () => {
		const parameters = Array.from({ length: 70 }, (_, index) => `value${index}`);
		const source = `function wide(${parameters.join(", ")}) {
			const pair = value0.a + value0.b;
			globalThis.collect();
			return pair + ${parameters
				.slice(1)
				.map((name) => `${name}.a`)
				.join(" + ")};
		} globalThis.wide = wide;`;
		const image = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(source, "/wide-fallback.js"),
		);
		const native = image.native.functions[1]!;
		expect(native.storage?.rootRegisters.length).toBeGreaterThan(64);
		const output = emitCompiledFunction(native, 1, "", false)?.source;
		expect(output).toContain("MAL_ROOT_MASK_WIDE(");
		expect(output).toContain("mal_vm_property_try_load_static_number_pair(");
	});
	it("preserves certified region exits through native edge copies", () => {
		const source = `globalThis.sum = function sum(value, regexp) {
			let sum = 0;
			for (const match of value.matchAll(regexp)) {
				sum += Number(match[1]);
				if (sum > 10) break;
			}
			return sum;
		};`;
		const image = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(source, "/native-region-exit.js"),
			{ facts: compilerProgramFactsFromConfig(resolveBuildConfig({})) },
		);
		const fn = image.native.functions[1]!;
		const region = fn.specializations.find(
			(region) => region.kind === "regexp-iterator-projection",
		);
		if (region?.kind !== "regexp-iterator-projection")
			throw new Error("Missing RegExp iterator projection");
		const branch = fn.body.instructions[region.doneBranchIp]!;
		if (branch.opcode !== "JUMP_IF") throw new Error("Missing region exit branch");
		expect(branch.targetIp).not.toBe(region.exitIp);
		expect(emitCompiledFunction(fn, fn.functionIndex, "", false)).not.toBeNull();
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		expect(() => emitProgramImage(restored, { compiled: true })).not.toThrow();
		const invalid = {
			...image,
			native: {
				...image.native,
				functions: image.native.functions.map((native) =>
					native !== fn
						? native
						: {
								...fn,
								body: {
									...fn.body,
									instructions: fn.body.instructions.map((op) =>
										op !== branch ? op : { ...branch, targetIp: region.loads[0]!.ip },
									),
								},
							},
				),
			},
		};
		expect(() => serializeCompilerArtifact(invalid)).toThrow(
			/invalid RegExp iterator projection/,
		);
	});

	const scalarImage = (body: string, profile = false) =>
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`globalThis.scalar = (left, right, one) => {
					const a = +left;
					const b = +right;
					const subtract = +one;
					${body}
				};`,
				"/native-expression.js",
			),
			{ profile },
		);
	const multiplicationIp = (image: ReturnType<typeof scalarImage>) =>
		image.native.functions[1]!.body.instructions.findIndex(
			(op) => op.opcode === "BINARY" && op.operator === "*",
		);

	it("carries proven single-use scalar expressions through the artifact", () => {
		const image = scalarImage("return a * b - subtract;");
		const multiplication = multiplicationIp(image);
		expect(multiplication).toBeGreaterThanOrEqual(0);
		expect(image.native.functions[1]!.storage!.expressionIps).toContain(multiplication);
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		expect(restored.native.functions[1]!.storage).toEqual(
			image.native.functions[1]!.storage,
		);
	});

	it("retains producers around effects, repeated uses, and profiling", () => {
		for (const body of [
			"const product = a * b; globalThis.observe(); return product - subtract;",
			"const product = a * b; return product + product;",
		]) {
			const image = scalarImage(body);
			expect(image.native.functions[1]!.storage!.expressionIps).not.toContain(
				multiplicationIp(image),
			);
		}
		const profiled = scalarImage("return a * b - subtract;", true);
		expect(profiled.native.functions[1]!.storage!.expressionIps).toEqual([]);
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(profiled));
		expect(restored.native.functions[1]!.storage!.expressionIps).toEqual([]);
	});

	it("rejects an expression choice that crosses an observable call", () => {
		const image = scalarImage(
			"const product = a * b; globalThis.observe(); return product - subtract;",
		);
		const native = image.native.functions[1]!;
		const malformed = {
			...image,
			native: {
				...image.native,
				functions: image.native.functions.map((fn) =>
					fn !== native
						? fn
						: {
								...fn,
								storage: { ...fn.storage!, expressionIps: [multiplicationIp(image)] },
							},
				),
			},
		};
		expect(() => serializeCompilerArtifact(malformed)).toThrow(
			/invalid or stale storage plan/,
		);
	});

	it("owns value identities and a body independently of VM register coloring", () => {
		const core = optimizeSemanticProgramToCore(
			analyzeSourceAndRunSemanticAnalysis(source, "/native-storage.js"),
			{},
			(_phase, run) => run(),
		);
		const colored = lowerCoreCompilationToExecutionProgram(core);
		const unique = lowerCoreCompilationToExecutionProgram(core, {
			reuseRegisters: false,
		});
		expect(colored.functions.map((fn) => fn.registerCount)).not.toEqual(
			unique.functions.map((fn) => fn.registerCount),
		);
		const native = lowerCoreCompilationToNativeProgram(core);
		for (const fn of native.functions) {
			const values = fn.storageValues.filter((value) => value >= 0);
			expect(new Set(values).size).toBe(values.length);
		}
		const first = lowerExecutionToProgramImage(colored, native);
		const second = lowerExecutionToProgramImage(unique, native);
		expect(first.native).toEqual(second.native);
		expect(
			first.native.functions.some(
				(fn, index) =>
					fn.body.registerCount > first.runtime.functions[index]!.registerCount,
			),
		).toBe(true);
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(first));
		expect(restored.native.functions.map((fn) => fn.body.instructions)).toEqual(
			first.native.functions.map((fn) => fn.body.instructions),
		);
		expect(restored.native.functions.map((fn) => fn.storageValues)).toEqual(
			first.native.functions.map((fn) => fn.storageValues),
		);
		expect(() => emitProgramImage(restored, { compiled: true })).not.toThrow();
	});
});
