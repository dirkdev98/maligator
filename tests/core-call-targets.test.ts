import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import {
	CORE_CALLEE_TARGETS_ANY_SCRIPT,
	CORE_CALLEE_TARGETS_BOTTOM,
	CORE_CALLEE_TARGETS_OPAQUE,
	CORE_CALLEE_TARGET_CAP,
	CORE_CALL_GRAPH_ANALYSIS,
	coreCalleeTargetsAreOpen,
	coreCalleeTargetsFunction,
	coreCalleeTargetsIsBottom,
	coreCalleeTargetsSingleFunction,
	joinCoreCalleeTargets,
} from "../src/compiler/core/core-ir-call-targets.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import {
	analysisProgram,
	appendCaller,
	appendLeaf,
	programAnalysisContext,
} from "./helpers/core-program-analysis.ts";

describe("Core callee-target lattice", () => {
	it("keeps finite targets deterministic and widens at the cap", () => {
		let targets = CORE_CALLEE_TARGETS_BOTTOM;
		for (let index = CORE_CALLEE_TARGET_CAP - 1; index >= 0; index--) {
			targets = joinCoreCalleeTargets(
				targets,
				coreCalleeTargetsFunction(index),
			);
		}
		expect(targets.functions).toEqual([0, 1, 2, 3]);
		expect(coreCalleeTargetsAreOpen(targets)).toBe(false);
		const widened = joinCoreCalleeTargets(
			targets,
			coreCalleeTargetsFunction(CORE_CALLEE_TARGET_CAP),
		);
		expect(widened).toMatchObject({ functions: [], anyScript: true });
	});

	it("keeps bottom, opaque, and any-script independent", () => {
		expect(coreCalleeTargetsIsBottom(CORE_CALLEE_TARGETS_BOTTOM)).toBe(true);
		expect(coreCalleeTargetsAreOpen(CORE_CALLEE_TARGETS_OPAQUE)).toBe(true);
		expect(coreCalleeTargetsAreOpen(CORE_CALLEE_TARGETS_ANY_SCRIPT)).toBe(true);
		expect(coreCalleeTargetsSingleFunction(coreCalleeTargetsFunction(2))).toBe(2);
	});
});

describe("incremental Core call graph", () => {
	it("rebuilds only the edited caller and updates its reverse edge", () => {
		const program = analysisProgram();
		const caller = appendCaller(program, 1);
		appendLeaf(program);
		appendLeaf(program);
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const first = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
		expect(first.statistics).toMatchObject({
			functionsAnalyzed: 3,
			functionsReused: 0,
			callSites: 1,
			updatedCallSites: 1,
		});
		expect([...first.callers(1 as never)]).toEqual([caller.function]);

		const editor = CoreEditor.open(program, caller.function);
		editor.replaceInstruction(
			caller.createFunctionInstruction,
			"createFunction",
			[],
			{ attributes: { functionIndex: 2 } },
		);
		editor.commit();
		const second = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
		expect(second.statistics).toMatchObject({
			functionsAnalyzed: 1,
			functionsReused: 2,
			updatedCallSites: 1,
		});
		expect([...second.callers(1 as never)]).toEqual([]);
		expect([...second.callers(2 as never)]).toEqual([caller.function]);
		expect(second.site(`${caller.function}:${caller.callInstruction}`)?.targets.functions)
			.toEqual([2]);
	});

	it("joins branch arguments without round-based program rescans", () => {
		const program = analysisProgram();
		const caller = appendCaller(program, 1);
		appendLeaf(program);
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const first = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
		const second = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
		expect(second).toBe(first);
		expect(second.outgoing(caller.function)).toHaveLength(1);
	});
});
