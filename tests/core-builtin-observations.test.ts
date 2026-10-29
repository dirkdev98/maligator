import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import {
	coreKnownBuiltinInvocationEffects,
	coreKnownBuiltinOnlyObservesOperands,
} from "../src/compiler/core/core-builtin-effects.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { coreCalleeTargetsCallability } from "../src/compiler/core/core-ir-call-targets.ts";
import { coreInstructionEffects } from "../src/compiler/core/core-ir-opcodes.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import {
	CORE_CALL_GRAPH_ANALYSIS,
	CORE_PROGRAM_SUMMARIES_ANALYSIS,
} from "../src/compiler/core/core-program-flow-analysis.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { optimizeSemanticProgramToCore } from "../src/compiler/pipeline/compile-core-common.ts";
import {
	compilerProgramFactsFromConfig,
	programClosureCertificate,
	withProgramClosure,
} from "../src/compiler/shared/compiler-facts.ts";
import { coreFunctionNamed, coreOperations } from "./helpers/core-inspection.ts";
import {
	analysisProgram,
	programAnalysisContext,
} from "./helpers/core-program-analysis.ts";

function predicate(operation: string, attributes = {}, opcode = "callKnown") {
	const program = analysisProgram();
	const builder = new CoreFunctionBuilder(program, { parameterCount: 2 });
	const entry = builder.createBlock([{}, {}]);
	const operands = [0, 1].map((index) => builder.blockParameterValue(entry, index));
	const [receiver] = builder.appendInstruction(entry, "createUndefined", []);
	const inputs = [receiver!, ...operands];
	const [result] = builder.appendInstruction(entry, opcode, inputs, {
		attributes: { operation, ...attributes },
	});
	const instruction = builder.bodyInstructionIds(entry).at(-1)!;
	builder.setTerminator(entry, { kind: "return", value: result! });
	const fn = program.function(builder.finish(entry).function);
	const analyses = new CoreAnalysisManager(
		program,
		programAnalysisContext(),
		new CoreOptimizationReportBuilder(program),
	);
	return { program, fn, instruction, inputs, analyses };
}

describe("builtin operand observations", () => {
	it.each(["Object.is", "ArrayBuffer.isView", "Date.now", "Array.isArray"])(
		"preserves operand containment through %s with conservative invocation effects",
		(operation) => {
			const { fn, instruction, analyses } = predicate(operation);
			expect(coreKnownBuiltinOnlyObservesOperands(fn, instruction)).toBe(true);
			const summary = analyses
				.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, { scope: "program" })
				.summary(fn.id)!;
			expect(summary.parameterEscape).toEqual(["none", "none"]);
			expect(summary.parameterContainment).toEqual(["preserved", "preserved"]);
			expect(summary.effects).toMatchObject({ mayGc: true, mayThrow: true });
			if (operation === "Array.isArray")
				expect(coreKnownBuiltinInvocationEffects(fn, instruction)).toMatchObject({
					mayThrow: true,
					mayGc: true,
				});
		},
	);

	it.each(["Object.keys", "Object.freeze", "Math.abs", "Object.hasOwn"])(
		"withholds an observation contract for %s",
		(operation) => {
			const { fn, instruction, analyses } = predicate(operation);
			expect(coreKnownBuiltinOnlyObservesOperands(fn, instruction)).toBe(false);
			expect(
				analyses.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, { scope: "program" }).summary(fn.id)
					?.parameterEscape[0],
			).toBe("retained");
		},
	);

	it.each([{ construct: true }, { argumentMode: "iterable" }])(
		"keeps invocation preparation conservative for %j",
		(attributes) => {
			const { fn, instruction } = predicate("Object.is", attributes);
			expect(coreKnownBuiltinOnlyObservesOperands(fn, instruction)).toBe(false);
		},
	);

	it("does not authorize an observation from a guarded method hint", () => {
		const { fn, instruction } = predicate(
			"Object.is",
			{ knownBuiltinCall: { operation: "Object.is" } },
			"call",
		);
		expect(coreKnownBuiltinOnlyObservesOperands(fn, instruction)).toBe(false);
	});

	it("withdraws and rediscovers retention summaries when the builtin changes", () => {
		const { program, fn, instruction, inputs, analyses } = predicate("Object.is");
		for (const operation of ["Object.is", "Object.hasOwn", "Object.is"]) {
			const edit = CoreEditor.open(program, fn.id);
			edit.replaceInstruction(instruction, "callKnown", inputs, {
				attributes: { operation },
			});
			edit.commit();
			const summary = analyses
				.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, { scope: "program" })
				.summary(fn.id)!;
			expect(summary.parameterEscape).toEqual(
				operation === "Object.is" ? ["none", "none"] : ["retained", "retained"],
			);
		}
	});

	it("does not publish observed functions and refreshes their caller bounds after edits", () => {
		const program = analysisProgram();
		const root = new CoreFunctionBuilder(program);
		const entry = root.createBlock();
		const [callback] = root.appendInstruction(entry, "createFunction", [], {
			attributes: { functionIndex: 1 },
		});
		const [receiver] = root.appendInstruction(entry, "createUndefined", []);
		const inputs = [receiver!, callback!];
		root.appendInstruction(entry, "callKnown", inputs, {
			attributes: { operation: "ArrayBuffer.isView" },
		});
		const observation = root.bodyInstructionIds(entry).at(-1)!;
		const [argument] = root.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 39 },
		});
		const [result] = root.appendInstruction(entry, "call", [
			callback!,
			receiver!,
			argument!,
		]);
		root.setTerminator(entry, { kind: "return", value: result! });
		const rootId = root.finish(entry).function;
		const callee = new CoreFunctionBuilder(program, { parameterCount: 1 });
		const calleeEntry = callee.createBlock([{}]);
		const parameter = callee.blockParameterValue(calleeEntry, 0);
		callee.setTerminator(calleeEntry, { kind: "return", value: parameter });
		const fn = callee.finish(calleeEntry).function;
		const analyses = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		for (const operation of [
			"ArrayBuffer.isView",
			"Object.hasOwn",
			"ArrayBuffer.isView",
		]) {
			const edit = CoreEditor.open(program, rootId);
			edit.replaceInstruction(observation, "callKnown", inputs, {
				attributes: { operation },
			});
			edit.commit();
			const graph = analyses.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
			expect(graph.publishedFunctions(rootId).includes(fn)).toBe(
				operation === "Object.hasOwn",
			);
			expect(coreCalleeTargetsCallability(graph.targets(fn, parameter))).toBe(
				operation === "Object.hasOwn" ? undefined : false,
			);
		}
	});

	it.each([
		["ArrayBuffer.isView", "locked", false],
		["Object.is", "locked", false],
		["ArrayBuffer.isView", "mutable", true],
		["isFinite", "locked", true],
	] as const)(
		"keeps own-slot loads consistent across %s with %s primordials",
		(operation, primordials, keepsLoad) => {
			const path = "/builtin-observation.mjs";
			const source = `const inspect=function inspect(record){for(let i=0;i<3;i++)if(${operation}(record))return record.x;return record.y;};function compute(input){const record={x:input,y:13};const before=record.x;const result=inspect(record);return before===record.x&&result===13;}globalThis.compute=compute;`;
			const facts = withProgramClosure(
				compilerProgramFactsFromConfig(
					resolveBuildConfig({ engine: { primordials, realms: false, eval: false } }),
				),
				programClosureCertificate({ kind: "whole-program", entry: path }, [], []),
			);
			const core = optimizeSemanticProgramToCore(
				analyzeSourceAndRunSemanticAnalysis(source, path),
				{ facts, coreVerification: "per-pass" },
				(_phase, run) => run(),
			);
			const fn = coreFunctionNamed(core.program, "compute")!;
			const operations = coreOperations(fn);
			const call = operations.find((op) => op.opcode === "call");
			expect(call).toBeDefined();
			expect(operations.some((op) => op.opcode === "loadPropertyStatic")).toBe(keepsLoad);
			if (!keepsLoad)
				expect(coreInstructionEffects(fn, call!.id)).toMatchObject({
					mayGc: true,
					mayThrow: true,
				});
		},
	);
});
