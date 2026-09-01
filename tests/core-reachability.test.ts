import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { CORE_CALL_GRAPH_ANALYSIS } from "../src/compiler/core/core-ir-call-targets.ts";
import {
	CORE_FUNCTION_REACHABILITY_ANALYSIS,
	analyzeCoreFunctionReachability,
} from "../src/compiler/core/core-ir-reachability.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { optimizeCore } from "../src/compiler/core/optimize.ts";
import { lowerCoreCompilationToExecutionProgram } from "../src/compiler/target/lower-execution.ts";
import {
	analysisProgram,
	appendCaller,
	appendLeaf,
	programAnalysisContext,
} from "./helpers/core-program-analysis.ts";

function directReachability(sourceClosed = true) {
	const program = analysisProgram();
	appendCaller(program, 1);
	const retained = new CoreFunctionBuilder(program, {
		metadata: { capturedCount: 1, sourcePath: "/entry.js" },
	});
	const retainedEntry = retained.createBlock();
	const [retainedValue] = retained.appendInstruction(
		retainedEntry,
		"createUndefined",
		[],
	);
	retained.setTerminator(retainedEntry, { kind: "return", value: retainedValue! });
	retained.finish(retainedEntry);
	appendLeaf(program, "/dead.js");
	const context = programAnalysisContext(sourceClosed);
	const manager = new CoreAnalysisManager(
		program,
		context,
		new CoreOptimizationReportBuilder(program),
	);
	const targets = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
	return {
		program,
		context,
		reachability: analyzeCoreFunctionReachability(program, targets, context),
	};
}

describe("Core function reachability", () => {
	it("keeps stable identities and marks an unreferenced closed-world function dead", () => {
		const { reachability } = directReachability();
		expect(reachability.liveFunctions).toEqual([0, 1]);
		expect([...reachability.dead]).toEqual([2]);
		expect(reachability.statistics).toMatchObject({
			functions: 3,
			functionsScanned: 2,
			deadFunctions: 1,
		});
	});

	it("retains every body without a source-closure certificate", () => {
		const { reachability } = directReachability(false);
		expect(reachability.liveFunctions).toEqual([0, 1, 2]);
		expect(reachability.dead.size).toBe(0);
	});

	it("reads each host-install slot once from the global-store index", () => {
		const program = analysisProgram();
		appendLeaf(program);
		const installer = new CoreFunctionBuilder(program);
		const entry = installer.createBlock();
		const [installed] = installer.appendInstruction(entry, "createFunction", [], {
			attributes: { functionIndex: 2 },
		});
		installer.appendInstruction(entry, "storeGlobal", [installed!], {
			outputCount: 0,
			attributes: { index: 0 },
		});
		const [result] = installer.appendInstruction(entry, "createUndefined", []);
		installer.setTerminator(entry, { kind: "return", value: result! });
		installer.finish(entry);
		appendLeaf(program);
		const baseContext = programAnalysisContext();
		const context = {
			...baseContext,
			data: {
				...baseContext.data,
				hostInstallCandidates: [
					{
						installer: "test",
						exports: [
							{ name: "first", slot: 0 },
							{ name: "alias", slot: 0 },
							{ name: "empty", slot: 1 },
						],
					},
				],
			},
		};
		const manager = new CoreAnalysisManager(
			program,
			context,
			new CoreOptimizationReportBuilder(program),
		);
		const reachability = manager.get(CORE_FUNCTION_REACHABILITY_ANALYSIS, {
			scope: "program",
		});

		expect(reachability.liveFunctions).toEqual([0, 2]);
		expect(reachability.reasons.get(2 as never)).toContain("host-install");
		expect(reachability.statistics.hostInstallSlotsRead).toBe(2);
	});

	it("omits dead rows only in the target map without compacting Core", () => {
		const { program, context } = directReachability();
		const optimized = optimizeCore({ program, context }).compilation;
		expect([...optimized.program.functionIds()]).toEqual([0, 1, 2]);
		expect(optimized.plan.liveFunctions).toEqual([0, 1]);
		const execution = lowerCoreCompilationToExecutionProgram(optimized);
		expect(execution.functions).toHaveLength(2);
		expect(execution.functionMap.executionToCore).toEqual([0, 1]);
		expect(execution.functionMap.coreToExecution).toEqual([0, 1, -1]);
	});

	it("reuses live reachability when an isolated dead component changes", () => {
		const program = analysisProgram();
		appendCaller(program, 1);
		appendLeaf(program);
		const isolated = appendCaller(program, 3);
		appendLeaf(program);
		appendLeaf(program);
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const first = manager.get(CORE_FUNCTION_REACHABILITY_ANALYSIS, {
			scope: "program",
		});
		const entryReasons = first.reasons.get(0 as never);

		const editor = CoreEditor.open(program, isolated.function);
		editor.replaceInstruction(isolated.createFunctionInstruction, "createFunction", [], {
			attributes: { functionIndex: 4 },
		});
		editor.commit();
		const second = manager.get(CORE_FUNCTION_REACHABILITY_ANALYSIS, {
			scope: "program",
		});

		expect(second.executable).toBe(first.executable);
		expect(second.dead).toBe(first.dead);
		expect(second.liveFunctions).toBe(first.liveFunctions);
		expect(second.reasons.get(0 as never)).toBe(entryReasons);
		expect(second.statistics).toMatchObject({
			functionsIndexed: 1,
			functionsScanned: 0,
			resultSetUpdates: 0,
		});
	});

	it("recomputes only the downstream reachability chain of a live call edit", () => {
		const program = analysisProgram();
		appendCaller(program, 1);
		const edited = appendCaller(program, 2);
		appendLeaf(program);
		appendCaller(program, 4);
		appendLeaf(program);
		appendLeaf(program);
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const first = manager.get(CORE_FUNCTION_REACHABILITY_ANALYSIS, {
			scope: "program",
		});
		const unrelatedReasons = first.reasons.get(3 as never);

		const editor = CoreEditor.open(program, edited.function);
		editor.replaceInstruction(edited.createFunctionInstruction, "createFunction", [], {
			attributes: { functionIndex: 5 },
		});
		editor.commit();
		const second = manager.get(CORE_FUNCTION_REACHABILITY_ANALYSIS, {
			scope: "program",
		});

		expect(second.liveFunctions).toEqual([0, 1, 5]);
		expect(second.reasons.get(3 as never)).toBe(unrelatedReasons);
		expect(second.statistics).toMatchObject({
			functionsIndexed: 1,
			functionsScanned: 1,
			resultSetUpdates: 2,
		});
	});
});
