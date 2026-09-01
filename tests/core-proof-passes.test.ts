import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import type { CoreCompilationContext } from "../src/compiler/core/core-compilation.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import {
	CORE_FACT_AVAILABILITY_ANALYSIS,
	analyzeCoreFactAvailability,
} from "../src/compiler/core/core-ir-fact-implication.ts";
import {
	CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS,
	buildCoreControlFlow,
} from "../src/compiler/core/core-ir-control-flow.ts";
import { CORE_LOCAL_VALUE_KIND_ANALYSIS, analyzeCoreValueKinds } from "../src/compiler/core/core-ir-value-kinds.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CorePassManager } from "../src/compiler/core/core-pass-manager.ts";
import { CORE_PROOF_PASSES } from "../src/compiler/core/core-proof-passes.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { conservativeCompilerProgramFacts } from "../src/compiler/shared/compiler-facts.ts";
import {
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_NUMBER,
} from "../src/compiler/shared/compiler-value-kinds.ts";

const context: CoreCompilationContext = {
	facts: conservativeCompilerProgramFacts(),
	data: {
		entrypointPath: "proof-passes.js",
		moduleEvaluationOrder: ["proof-passes.js"],
		sourceFiles: [{ path: "proof-passes.js", contents: "" }],
		cjsModuleFunctionIndices: [],
		hostInstallCandidates: [],
		singleAssignmentGlobalSlots: [],
		singleAssignmentCapturedSlots: [],
		retainedHostInstallers: [],
	},
};

describe("Core local proofs and representations", () => {
	it("makes a guard fact available only where its success edge dominates", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{ representation: "boolean" }, { representation: "boxed" }]);
		const success = builder.createBlock();
		const fallback = builder.createBlock();
		const merge = builder.createBlock();
		const [condition, subject] = builder.blockParameters(entry).map(({ value }) => value);
		const fact = builder.setGuardTerminator(entry, {
			condition: condition!,
			success: { block: success, arguments: [] },
			fallback: { block: fallback, arguments: [] },
			fact: {
				kind: "identity-test",
				value: "number",
				claims: [{ kind: "identity", subject: subject!, identities: [1] }],
				origin: "test",
			},
		});
		builder.setTerminator(success, { kind: "jump", edge: { block: merge, arguments: [] } });
		builder.setTerminator(fallback, { kind: "jump", edge: { block: merge, arguments: [] } });
		builder.setTerminator(merge, { kind: "return", value: subject! });
		const finished = builder.finish(entry);
		const fn = program.function(finished.function);
		const availability = analyzeCoreFactAvailability(fn, buildCoreControlFlow(program, finished.function));
		expect(availability.availableAtBlock(success)).toContain(fact);
		expect(availability.availableAtBlock(fallback)).not.toContain(fact);
		expect(availability.availableAtBlock(merge)).not.toContain(fact);
	});

	it("solves exact local kinds with a bounded value worklist", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const [one] = builder.appendInstruction(entry, "createNumber", [], { attributes: { value: 1 } });
		const [two] = builder.appendInstruction(entry, "createNumber", [], { attributes: { value: 2 } });
		const [sum] = builder.appendInstruction(entry, "binary", [one!, two!], { attributes: { operator: "+" } });
		const [comparison] = builder.appendInstruction(entry, "binary", [sum!, two!], { attributes: { operator: ">" } });
		builder.setTerminator(entry, { kind: "return", value: comparison! });
		const finished = builder.finish(entry);
		const fn = program.function(finished.function);
		const kinds = analyzeCoreValueKinds(fn, buildCoreControlFlow(program, finished.function));
		expect(kinds.kindMask(sum!)).toBe(COMPILER_VALUE_KIND_NUMBER);
		expect(kinds.kindMask(comparison!)).toBe(COMPILER_VALUE_KIND_BOOLEAN);
		expect(kinds.exactScalar(one!)).toBe("int32");
		expect(kinds.exactScalar(sum!)).toBe("number");
	});

	it("materializes primitive effects with stable proof references and scalar representations", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const [one] = builder.appendInstruction(entry, "createNumber", [], { attributes: { value: 1 } });
		const [two] = builder.appendInstruction(entry, "createNumber", [], { attributes: { value: 2 } });
		const [sum] = builder.appendInstruction(entry, "binary", [one!, two!], { attributes: { operator: "+" } });
		builder.setTerminator(entry, { kind: "return", value: sum! });
		const finished = builder.finish(entry);
		const fn = program.function(finished.function);
		const sumDefinition = fn.valueDefinition(sum!);
		if (sumDefinition.kind !== "instruction") throw new Error("Expected instruction result");
		const report = new CoreOptimizationReportBuilder(program);
		const analyses = new CoreAnalysisManager(program, context, report);
		new CorePassManager(program, context, analyses, report).runStage("proofs", CORE_PROOF_PASSES);
		const refinement = fn.instructionEffectRefinement(sumDefinition.instruction);
		expect(refinement).toBeDefined();
		expect(fn.fact(refinement!.proof)).toMatchObject({
			id: refinement!.proof,
			kind: "primitive-operator-effects",
			claims: [{ kind: "effect", instruction: sumDefinition.instruction }],
		});
		expect(fn.valueRepresentation(one!)).toBe("i32");
		expect(fn.valueRepresentation(two!)).toBe("i32");
		expect(fn.valueRepresentation(sum!)).toBe("f64");
	});

	it("invalidates fact availability without discarding CFG or kind analyses", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const functions = Array.from({ length: 2 }, () => {
			const builder = new CoreFunctionBuilder(program);
			const entry = builder.createBlock([{ representation: "boxed" }]);
			const value = builder.blockParameters(entry)[0]!.value;
			builder.setTerminator(entry, { kind: "return", value });
			return { ...builder.finish(entry), value };
		});
		const report = new CoreOptimizationReportBuilder(program);
		const analyses = new CoreAnalysisManager(program, context, report);
		const firstCfg = analyses.get(CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS, { scope: "function", function: functions[0]!.function });
		const firstFacts = analyses.get(CORE_FACT_AVAILABILITY_ANALYSIS, { scope: "function", function: functions[0]!.function });
		const firstKinds = analyses.get(CORE_LOCAL_VALUE_KIND_ANALYSIS, { scope: "function", function: functions[0]!.function });
		const otherKinds = analyses.get(CORE_LOCAL_VALUE_KIND_ANALYSIS, { scope: "function", function: functions[1]!.function });
		const editor = CoreEditor.open(program, functions[0]!.function);
		editor.addFact({
			kind: "local-test",
			value: true,
			claims: [{ kind: "identity", subject: functions[0]!.value, identities: [1] }],
			validity: { kind: "asserted", source: "test" },
			obligations: [],
			origin: "test",
		});
		editor.commit();
		expect(analyses.get(CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS, { scope: "function", function: functions[0]!.function })).toBe(firstCfg);
		expect(analyses.get(CORE_FACT_AVAILABILITY_ANALYSIS, { scope: "function", function: functions[0]!.function })).not.toBe(firstFacts);
		expect(analyses.get(CORE_LOCAL_VALUE_KIND_ANALYSIS, { scope: "function", function: functions[0]!.function })).toBe(firstKinds);
		expect(analyses.get(CORE_LOCAL_VALUE_KIND_ANALYSIS, { scope: "function", function: functions[1]!.function })).toBe(otherKinds);
	});
});
