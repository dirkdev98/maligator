import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CORE_CALL_GRAPH_ANALYSIS } from "../src/compiler/core/core-ir-call-targets.ts";
import { analyzeCoreFunctionReachability } from "../src/compiler/core/core-ir-reachability.ts";
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
});
