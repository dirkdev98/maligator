import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { analyzeCoreFunctionReachability } from "../src/compiler/core/core-ir-reachability.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import {
	CORE_CALL_GRAPH_ANALYSIS,
	CORE_FUNCTION_REACHABILITY_ANALYSIS,
	CORE_PROGRAM_SUMMARIES_ANALYSIS,
} from "../src/compiler/core/core-program-flow-analysis.ts";
import { optimizeCore } from "../src/compiler/core/optimize.ts";
import { lowerCoreCompilationToExecutionProgram } from "../src/compiler/target/lower-execution.ts";
import { inspectCoreBlockParameters } from "./helpers/core-inspection.ts";
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

function appendAnyScriptCaller(program: ReturnType<typeof analysisProgram>) {
	const functionIndex = program.functionCapacity;
	const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
	const entry = builder.createBlock([{ representation: "boxed" }]);
	const condition = inspectCoreBlockParameters(builder, entry)[0]!.value;
	const join = builder.createBlock([{ representation: "boxed" }]);
	let decision = entry;
	for (let offset = 1; offset <= 5; offset++) {
		const selected = builder.createBlock();
		const alternate = builder.createBlock();
		const [callee] = builder.appendInstruction(selected, "createFunction", [], {
			attributes: { functionIndex: functionIndex + offset },
		});
		builder.setTerminator(selected, {
			kind: "jump",
			edge: { block: join, arguments: [callee!] },
		});
		builder.setTerminator(decision, {
			kind: "branch",
			condition,
			consequent: { block: selected, arguments: [] },
			alternate: { block: alternate, arguments: [] },
		});
		decision = alternate;
	}
	const [fallback] = builder.appendInstruction(decision, "createUndefined", []);
	builder.setTerminator(decision, {
		kind: "jump",
		edge: { block: join, arguments: [fallback!] },
	});
	const callee = inspectCoreBlockParameters(builder, join)[0]!.value;
	const [receiver] = builder.appendInstruction(join, "createUndefined", []);
	const [result] = builder.appendInstruction(join, "call", [callee, receiver!]);
	builder.setTerminator(join, { kind: "return", value: result! });
	return builder.finish(entry);
}

function appendGlobalFunctionStore(
	program: ReturnType<typeof analysisProgram>,
	target: number,
) {
	const builder = new CoreFunctionBuilder(program);
	const entry = builder.createBlock();
	const [stored] = builder.appendInstruction(entry, "createFunction", [], {
		attributes: { functionIndex: target },
	});
	builder.appendInstruction(entry, "storeGlobal", [stored!], {
		outputCount: 0,
		attributes: { index: 0 },
	});
	const [result] = builder.appendInstruction(entry, "createUndefined", []);
	builder.setTerminator(entry, { kind: "return", value: result! });
	return builder.finish(entry).function;
}

function appendOpaqueGlobalStore(program: ReturnType<typeof analysisProgram>) {
	const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
	const entry = builder.createBlock([{ representation: "boxed" }]);
	const stored = inspectCoreBlockParameters(builder, entry)[0]!.value;
	builder.appendInstruction(entry, "storeGlobal", [stored], {
		outputCount: 0,
		attributes: { index: 0 },
	});
	const [result] = builder.appendInstruction(entry, "createUndefined", []);
	builder.setTerminator(entry, { kind: "return", value: result! });
	return builder.finish(entry).function;
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

	it("keeps any-script reachability compact", () => {
		const program = analysisProgram();
		appendAnyScriptCaller(program);
		for (let index = 0; index < 6; index++) appendLeaf(program);
		const context = programAnalysisContext();
		const manager = new CoreAnalysisManager(
			program,
			context,
			new CoreOptimizationReportBuilder(program),
		);
		const reachability = manager.get(CORE_FUNCTION_REACHABILITY_ANALYSIS, {
			scope: "program",
		});

		expect(reachability.liveFunctions).toEqual([0, 1, 2, 3, 4, 5, 6]);
		expect(reachability.reasons.get(6 as never)).toContain("any-script");
		expect(reachability.targets.graph.wildcardCallers).toEqual([0]);
		expect(reachability.targets.graph.exactOutgoing(0 as never)).toEqual([]);
		expect(reachability.statistics).toMatchObject({
			exactCallEdgesFollowed: 0,
			wildcardCallerVisits: 1,
			aggregateDependencyVisits: 7,
		});

		const removedTarget = [...program.function(0 as never).instructionIds()].find(
			(instruction) =>
				program.function(0 as never).instructionKind(instruction) === "operation" &&
				program.function(0 as never).instructionAttributes(instruction).functionIndex ===
					5,
		)!;
		const editor = CoreEditor.open(program, 0 as never);
		editor.replaceInstruction(removedTarget, "createUndefined", []);
		editor.commit();
		const updated = manager.get(CORE_FUNCTION_REACHABILITY_ANALYSIS, {
			scope: "program",
		});

		expect(updated.liveFunctions).toEqual([0, 1, 2, 3, 4]);
		expect(updated.targets.graph.wildcardCallers).toEqual([]);

		const reopenedEditor = CoreEditor.open(program, 0 as never);
		reopenedEditor.replaceInstruction(removedTarget, "createFunction", [], {
			attributes: { functionIndex: 5 },
		});
		reopenedEditor.commit();
		const reopened = manager.get(CORE_FUNCTION_REACHABILITY_ANALYSIS, {
			scope: "program",
		});

		expect(reopened.liveFunctions).toEqual([0, 1, 2, 3, 4, 5, 6]);
		expect(reopened.targets.graph.wildcardCallers).toEqual([0]);

		appendLeaf(program);
		const extended = manager.get(CORE_FUNCTION_REACHABILITY_ANALYSIS, {
			scope: "program",
		});

		expect(extended.liveFunctions).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
		expect(extended.reasons.get(7 as never)).toContain("any-script");
	});

	it("recomputes the universe when a stable open source becomes dead or live", () => {
		const program = analysisProgram();
		const entry = appendCaller(program, 1);
		appendAnyScriptCaller(program);
		for (let index = 0; index < 7; index++) appendLeaf(program);
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const initial = manager.get(CORE_FUNCTION_REACHABILITY_ANALYSIS, {
			scope: "program",
		});

		expect(initial.liveFunctions).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
		expect(initial.targets.graph.wildcardCallers).toEqual([1]);

		const close = CoreEditor.open(program, entry.function);
		close.replaceInstruction(entry.createFunctionInstruction, "createFunction", [], {
			attributes: { functionIndex: 8 },
		});
		close.commit();
		const closed = manager.get(CORE_FUNCTION_REACHABILITY_ANALYSIS, {
			scope: "program",
		});

		expect(closed.liveFunctions).toEqual([0, 8]);
		expect(closed.targets.graph.wildcardCallers).toEqual([1]);

		const reopen = CoreEditor.open(program, entry.function);
		reopen.replaceInstruction(entry.createFunctionInstruction, "createFunction", [], {
			attributes: { functionIndex: 1 },
		});
		reopen.commit();
		const reopened = manager.get(CORE_FUNCTION_REACHABILITY_ANALYSIS, {
			scope: "program",
		});

		expect(reopened.liveFunctions).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
		expect(reopened.targets.graph.wildcardCallers).toEqual([1]);
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

	it("roots every script function for a wildcard host install", () => {
		const program = analysisProgram();
		for (let index = 0; index < 5; index++) {
			appendGlobalFunctionStore(program, 5 + index);
		}
		for (let index = 0; index < 5; index++) appendLeaf(program);
		const baseContext = programAnalysisContext();
		const context = {
			...baseContext,
			data: {
				...baseContext.data,
				hostInstallCandidates: [
					{ installer: "test", exports: [{ name: "wildcard", slot: 0 }] },
				],
			},
		};
		const manager = new CoreAnalysisManager(
			program,
			context,
			new CoreOptimizationReportBuilder(program),
		);
		const targets = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
		const reachability = manager.get(CORE_FUNCTION_REACHABILITY_ANALYSIS, {
			scope: "program",
		});
		const summaries = manager.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, {
			scope: "program",
		});

		expect(targets.globalStoreTargets(0)).toMatchObject({
			functions: [],
			anyScript: true,
			opaque: false,
		});
		expect(reachability.liveFunctions).toEqual([...program.functionIds()]);
		for (const functionId of program.functionIds()) {
			expect(reachability.reasons.get(functionId)).toContain("host-install");
			expect(summaries.summary(functionId)?.rootReasons).toContain("host-install");
		}
	});

	it("does not invent script roots for an opaque-only host install", () => {
		const program = analysisProgram();
		const entry = appendOpaqueGlobalStore(program);
		const dead = appendLeaf(program).function;
		const baseContext = programAnalysisContext();
		const context = {
			...baseContext,
			data: {
				...baseContext.data,
				hostInstallCandidates: [
					{ installer: "test", exports: [{ name: "opaque", slot: 0 }] },
				],
			},
		};
		const manager = new CoreAnalysisManager(
			program,
			context,
			new CoreOptimizationReportBuilder(program),
		);
		const targets = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
		const reachability = manager.get(CORE_FUNCTION_REACHABILITY_ANALYSIS, {
			scope: "program",
		});
		const summaries = manager.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, {
			scope: "program",
		});

		expect(targets.globalStoreTargets(0)).toMatchObject({
			functions: [],
			anyScript: false,
			opaque: true,
		});
		expect(reachability.liveFunctions).toEqual([entry]);
		expect(reachability.dead).toEqual(new Set([dead]));
		for (const functionId of program.functionIds()) {
			expect(summaries.summary(functionId)?.rootReasons).not.toContain("host-install");
		}
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
			functionsScanned: 3,
			resultSetUpdates: 2,
		});
	});
});
