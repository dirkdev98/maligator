import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import type { CoreCompilationContext } from "../src/compiler/core/core-compilation.ts";
import {
	CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS,
	buildCoreControlFlow,
} from "../src/compiler/core/core-ir-control-flow.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import {
	CORE_NO_EFFECTS,
	CoreOpcodeRegistry,
	coreArity,
} from "../src/compiler/core/core-ir.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { analyzeCoreLocalExceptionFlows } from "../src/compiler/core/core-ir-exception-flow.ts";
import { analyzeCoreLoopInductions } from "../src/compiler/core/core-ir-loops.ts";
import { coreCanonicalValueRoots } from "../src/compiler/core/core-ir-control-flow.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { optimizeCore } from "../src/compiler/core/optimize.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { conservativeCompilerProgramFacts } from "../src/compiler/shared/compiler-facts.ts";

const context: CoreCompilationContext = {
	facts: conservativeCompilerProgramFacts(),
	data: {
		entrypointPath: "control-flow-passes.js",
		moduleEvaluationOrder: ["control-flow-passes.js"],
		sourceFiles: [{ path: "control-flow-passes.js", contents: "" }],
		cjsModuleFunctionIndices: [],
		hostInstallCandidates: [],
		singleAssignmentGlobalSlots: [],
		singleAssignmentCapturedSlots: [],
		retainedHostInstallers: [],
	},
};

describe("Core control-flow analyses and passes", () => {
	it("classifies a multi-entry cycle without inventing a natural loop", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{ representation: "boolean" }]);
		const left = builder.createBlock();
		const right = builder.createBlock();
		const exit = builder.createBlock();
		const condition = builder.blockParameters(entry)[0]!.value;
		builder.setTerminator(entry, {
			kind: "branch",
			condition,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		builder.setTerminator(left, { kind: "jump", edge: { block: right, arguments: [] } });
		builder.setTerminator(right, {
			kind: "branch",
			condition,
			consequent: { block: left, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		builder.setTerminator(exit, { kind: "return", value: condition });
		const finished = builder.finish(entry);
		const cfg = buildCoreControlFlow(program, finished.function);
		expect(cfg.loops).toEqual([]);
		expect(cfg.irreducibleCycles).toHaveLength(1);
		expect([...cfg.irreducibleCycles[0]!.entries]).toEqual([left, right]);
	});

	it("models only actually throwing handler edges and proves local throw flow", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const handler = builder.createBlock([{ role: "exception" }]);
		const [thrown] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 7 },
		});
		builder.setHandler(entry, handler);
		builder.setTerminator(entry, { kind: "throw", value: thrown! });
		builder.setTerminator(handler, {
			kind: "return",
			value: builder.blockParameters(handler)[0]!.value,
		});
		const finished = builder.finish(entry);
		const cfg = buildCoreControlFlow(program, finished.function);
		expect(cfg.successors[entry]).toMatchObject([
			{ from: entry, to: handler, kind: "exceptional", arguments: [] },
		]);
		expect(analyzeCoreLocalExceptionFlows(program.function(finished.function), cfg)).toMatchObject([
			{ source: entry, handler, thrownValue: thrown },
		]);
	});

	it("recognizes canonical induction ranges and loop nesting metadata", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const header = builder.createBlock([{ representation: "f64" }]);
		const latch = builder.createBlock([{ representation: "f64" }]);
		const exit = builder.createBlock();
		const [zero] = builder.appendInstruction(entry, "createF64", [], { attributes: { value: 0 }, outputRepresentations: ["f64"] });
		const [ten] = builder.appendInstruction(entry, "createF64", [], { attributes: { value: 10 }, outputRepresentations: ["f64"] });
		builder.setTerminator(entry, { kind: "jump", edge: { block: header, arguments: [zero!] } });
		const counter = builder.blockParameters(header)[0]!.value;
		const [condition] = builder.appendInstruction(header, "binary", [counter, ten!], {
			attributes: { operator: "<" }, outputRepresentations: ["boolean"],
		});
		builder.setTerminator(header, {
			kind: "branch", condition: condition!,
			consequent: { block: latch, arguments: [counter] },
			alternate: { block: exit, arguments: [] },
		});
		const latchCounter = builder.blockParameters(latch)[0]!.value;
		const [next] = builder.appendInstruction(latch, "unary", [latchCounter], {
			attributes: { operator: "increment" }, outputRepresentations: ["f64"],
		});
		builder.setTerminator(latch, { kind: "jump", edge: { block: header, arguments: [next!] } });
		builder.setTerminator(exit, { kind: "return", value: counter });
		const finished = builder.finish(entry);
		const fn = program.function(finished.function);
		const cfg = buildCoreControlFlow(program, finished.function);
		expect(cfg.loops).toMatchObject([{ header, preheader: entry, depth: 1, canonical: true }]);
		const loops = analyzeCoreLoopInductions(fn, cfg, coreCanonicalValueRoots(fn, cfg));
		expect(loops.induction(counter)).toMatchObject({ step: 1, range: { first: 0, last: 9, finalUpdate: 10 } });
	});

	it("eliminates partial redundancy on non-speculative merge edges", () => {
		const registry = new CoreOpcodeRegistry();
		registry.define({ opcode: "purePair", inputs: coreArity(2), outputs: coreArity(1), effects: CORE_NO_EFFECTS, discardable: true });
		registry.define({ opcode: "keep", inputs: coreArity(1), outputs: coreArity(0), effects: CORE_NO_EFFECTS, discardable: false });
		const program = new CoreProgram(registry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([
			{ representation: "boxed" }, { representation: "boxed" }, { representation: "boolean" },
		]);
		const left = builder.createBlock();
		const right = builder.createBlock();
		const merge = builder.createBlock();
		const [first, second, condition] = builder.blockParameters(entry).map(({ value }) => value);
		builder.setTerminator(entry, {
			kind: "branch", condition: condition!,
			consequent: { block: left, arguments: [] }, alternate: { block: right, arguments: [] },
		});
		const [available] = builder.appendInstruction(left, "purePair", [first!, second!]);
		builder.appendInstruction(left, "keep", [available!]);
		builder.setTerminator(left, { kind: "jump", edge: { block: merge, arguments: [] } });
		builder.appendInstruction(right, "keep", [first!]);
		builder.setTerminator(right, { kind: "jump", edge: { block: merge, arguments: [] } });
		const [redundant] = builder.appendInstruction(merge, "purePair", [first!, second!]);
		builder.setTerminator(merge, { kind: "return", value: redundant! });
		const finished = builder.finish(entry);
		const optimized = optimizeCore({ program, context });
		const fn = optimized.compilation.program.function(finished.function);
		expect(fn.blockParameters(merge)).toHaveLength(1);
		expect([...fn.bodyInstructionIds(merge)]).toEqual([]);
		expect(optimized.report.passes.find(({ pass }) => pass === "partial-redundancy-elimination")).toMatchObject({ changedItems: 1 });
	});

	it("reuses the real CFG analysis across operand-only rewrites", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const parameter = builder.blockParameters(entry)[0]!.value;
		const [copy] = builder.appendInstruction(entry, "move", [parameter]);
		builder.setTerminator(entry, { kind: "return", value: copy! });
		const finished = builder.finish(entry);
		const report = new CoreOptimizationReportBuilder(program);
		const analyses = new CoreAnalysisManager(program, context, report);
		const first = analyses.get(CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS, { scope: "function", function: finished.function });
		const definition = program.function(finished.function).valueDefinition(copy!);
		if (definition.kind !== "instruction") throw new Error("Expected move result");
		const editor = CoreEditor.open(program, finished.function);
		editor.replaceValueUses(copy!, parameter);
		editor.removeInstruction(definition.instruction);
		const changes = editor.commit();
		expect(changes.domains).not.toContain("cfg");
		const second = analyses.get(CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS, { scope: "function", function: finished.function });
		expect(second).toBe(first);
		const result = report.finish(program, { directEntries: [], specializations: [] });
		expect(result.analyses).toMatchObject([{ analysis: "exception-control-flow", queries: 2, hits: 1, recomputations: 1 }]);
	});
});
