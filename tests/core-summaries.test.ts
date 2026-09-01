import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { CORE_PROGRAM_SUMMARIES_ANALYSIS } from "../src/compiler/core/core-ir-summaries.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import {
	analysisProgram,
	appendCaller,
	appendLeaf,
	programAnalysisContext,
} from "./helpers/core-program-analysis.ts";

describe("incremental Core program summaries", () => {
	it("does not publish or wake a caller when an edited leaf is semantically unchanged", () => {
		const program = analysisProgram();
		appendCaller(program, 1);
		appendCaller(program, 2);
		const leaf = appendLeaf(program);
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const first = manager.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, {
			scope: "program",
		});
		const versions = [
			first.version(0 as never),
			first.version(1 as never),
			first.version(2 as never),
		];

		const editor = CoreEditor.open(program, leaf.function);
		editor.replaceInstruction(leaf.valueInstruction, "createUndefined", []);
		editor.commit();
		const second = manager.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, {
			scope: "program",
		});
		expect(second.statistics).toMatchObject({
			functionsAnalyzed: 1,
			functionsReused: 2,
			summaryChanges: 0,
			callerWakeups: 0,
			affectedCallers: 0,
		});
		expect([
			second.version(0 as never),
			second.version(1 as never),
			second.version(2 as never),
		]).toEqual(versions);
	});

	it("propagates a changed leaf only through reverse callers", () => {
		const program = analysisProgram();
		appendCaller(program, 1);
		appendCaller(program, 2);
		const leaf = appendLeaf(program);
		appendLeaf(program, "/unrelated.js");
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const first = manager.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, {
			scope: "program",
		});
		const unrelatedVersion = first.version(3 as never);

		const editor = CoreEditor.open(program, leaf.function);
		editor.replaceInstruction(leaf.valueInstruction, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		editor.commit();
		const second = manager.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, {
			scope: "program",
		});
		expect(second.statistics.functionsAnalyzed).toBe(1);
		expect(second.statistics.functionsReused).toBe(3);
		expect(second.statistics.summaryChanges).toBe(3);
		expect(second.statistics.affectedCallers).toBe(2);
		expect(second.version(0 as never)).toBe(first.version(0 as never) + 1);
		expect(second.version(1 as never)).toBe(first.version(1 as never) + 1);
		expect(second.version(2 as never)).toBe(first.version(2 as never) + 1);
		expect(second.version(3 as never)).toBe(unrelatedVersion);
	});

	it("solves a long chain with bounded SCC transfers", () => {
		const program = analysisProgram();
		const length = 64;
		for (let index = 0; index < length - 1; index++) {
			appendCaller(program, index + 1);
		}
		appendLeaf(program);
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const summaries = manager.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, {
			scope: "program",
		});
		expect(summaries.sccs).toHaveLength(length);
		expect(summaries.statistics.sccTransfers).toBeLessThanOrEqual(length * 2);
	});

	it("condenses a large recursive component into one SCC", () => {
		const program = analysisProgram();
		const length = 24;
		for (let index = 0; index < length; index++) {
			appendCaller(program, (index + 1) % length);
		}
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const summaries = manager.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, {
			scope: "program",
		});
		expect(summaries.sccs).toHaveLength(1);
		expect(summaries.sccs[0]!.functions).toHaveLength(length);
		expect(summaries.statistics.sccTransfers).toBeLessThanOrEqual(length * 2);
	});
});
