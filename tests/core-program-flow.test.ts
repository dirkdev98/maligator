import { describe, expect, it } from "vitest";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import {
	CORE_PROGRAM_FLOW_EFFECTS,
	CORE_PROGRAM_FLOW_RETURN_KIND,
	CORE_PROGRAM_FLOW_RUNTIME_IDENTITY,
	CORE_PROGRAM_FLOW_TARGET_CONSUMER,
	CORE_PROGRAM_FLOW_TARGETS,
	CoreProgramFlowEngine,
	coreProgramFlowDimensionsForDomains,
} from "../src/compiler/core/core-program-flow.ts";
import { CORE_PROGRAM_FLOW_MEMORY } from "../src/compiler/core/core-store.ts";
import {
	analysisProgram,
	appendCaller,
	appendLeaf,
} from "./helpers/core-program-analysis.ts";

describe("Core program flow", () => {
	it("deduplicates dirty functions within an immutable journal epoch", () => {
		const program = analysisProgram();
		const first = appendLeaf(program);
		appendLeaf(program);
		const report = new CoreOptimizationReportBuilder(program, "counters");
		const engine = new CoreProgramFlowEngine(program, report);
		const flow = engine.refresh(
			CORE_PROGRAM_FLOW_TARGET_CONSUMER,
			CORE_PROGRAM_FLOW_TARGETS,
		);

		expect(flow.dirtyFunctionCount).toBe(2);
		const firstEdit = CoreEditor.open(program, first.function);
		firstEdit.configureFunction({ isAsync: true });
		firstEdit.commit();
		const secondEdit = CoreEditor.open(program, first.function);
		secondEdit.configureFunction({ isGenerator: true });
		secondEdit.commit();
		engine.refresh(CORE_PROGRAM_FLOW_TARGET_CONSUMER, CORE_PROGRAM_FLOW_TARGETS);

		expect(flow.dirtyFunctionCount).toBe(1);
		expect(flow.dirtyFunctionAt(0)).toBe(first.function);
		expect(
			report.finish(program, { directEntries: [], specializations: [] }).counters,
		).toMatchObject({
			programFlowJournalEntries: 4,
			programFlowDirtyFunctions: 3,
			programFlowTargetWakeups: 3,
			programFlowSummaryWakeups: 0,
			programFlowValueKindWakeups: 0,
			programFlowReachabilityWakeups: 0,
		});
	});

	it("does not wake value kinds for an effect-only change", () => {
		const dimensions = coreProgramFlowDimensionsForDomains(CORE_PROGRAM_FLOW_MEMORY);

		expect(dimensions & CORE_PROGRAM_FLOW_EFFECTS).toBe(CORE_PROGRAM_FLOW_EFFECTS);
		expect(dimensions & CORE_PROGRAM_FLOW_RETURN_KIND).toBe(0);
	});

	it("shares numeric local transfers across consumers and stable functions", () => {
		const program = analysisProgram();
		const target = appendLeaf(program);
		const caller = appendCaller(program, target.function);
		const report = new CoreOptimizationReportBuilder(program, "counters");
		const engine = new CoreProgramFlowEngine(program, report);

		const first = engine.local(caller.function);
		expect(engine.local(caller.function)).toBe(first);
		expect(first.callCount).toBe(1);
		expect(first.structuralTargetCount).toBe(1);
		expect(first.structuralTargetAt(0)).toBe(target.function);
		expect(first.structuralReasonMaskAt(0)).toBe(CORE_PROGRAM_FLOW_RUNTIME_IDENTITY);

		const targetFunction = program.function(target.function);
		const value = targetFunction.kernel.resultAt(
			targetFunction.kernel.instructionResultStart(target.valueInstruction),
		);
		const representation = CoreEditor.open(program, target.function);
		representation.setValueRepresentation(value, "f64");
		representation.commit();
		expect(engine.local(caller.function)).toBe(first);

		const body = CoreEditor.open(program, caller.function);
		body.configureFunction({ isAsync: true });
		body.commit();
		expect(engine.local(caller.function)).not.toBe(first);
		expect(
			report.finish(program, { directEntries: [], specializations: [] }).counters,
		).toMatchObject({
			programFlowLocalScans: 2,
			programFlowLocalInstructionVisits: 8,
			programFlowTransferRecords: 10,
			programFlowTransferReuses: 2,
		});
	});
});
