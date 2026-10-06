import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { optimizeSemanticProgramToCore } from "../src/compiler/pipeline/compile-core-common.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
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
		const render = (image: typeof first) =>
			image.native.functions.map(
				(fn, index) =>
					emitCompiledFunction(image.runtime.functions[index]!, fn, index, "", false)
						?.source,
			);
		expect(render(first)).toEqual(render(second));
		expect(render(restored)).toEqual(render(first));
	});
});
