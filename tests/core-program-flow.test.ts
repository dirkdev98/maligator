import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { updateCoreCallGraph } from "../src/compiler/core/core-call-graph.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { CORE_NO_EFFECTS } from "../src/compiler/core/core-ir.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CORE_PROGRAM_FLOW_ANALYSIS } from "../src/compiler/core/core-program-flow-analysis.ts";
import {
	CORE_PROGRAM_FLOW_ALL_DIMENSIONS,
	CORE_PROGRAM_FLOW_EFFECTS,
	CORE_PROGRAM_FLOW_RETURN_KIND,
	CORE_PROGRAM_FLOW_RUNTIME_IDENTITY,
	CoreProgramFlowEngine,
	coreProgramFlowDimensionsForDomains,
	extractCoreProgramFlowLocalTransfers,
} from "../src/compiler/core/core-program-flow.ts";
import { CORE_PROGRAM_FLOW_MEMORY } from "../src/compiler/core/core-store.ts";
import {
	analysisProgram,
	appendCaller,
	appendLeaf,
	programAnalysisContext,
} from "./helpers/core-program-analysis.ts";

describe("Core program flow", () => {
	it("is the only production owner of whole-program convergence", () => {
		const owner = readFileSync(
			new URL("../src/compiler/core/core-program-flow-analysis.ts", import.meta.url),
			"utf8",
		);
		const engine = readFileSync(
			new URL("../src/compiler/core/core-program-flow.ts", import.meta.url),
			"utf8",
		);
		for (const module of [
			"core-ir-call-targets.ts",
			"core-ir-summaries.ts",
			"core-ir-value-kinds.ts",
			"core-ir-reachability.ts",
		]) {
			const source = readFileSync(
				new URL(`../src/compiler/core/${module}`, import.meta.url),
				"utf8",
			);
			expect(source).not.toMatch(
				/CORE_(?:CALL_GRAPH|PROGRAM_SUMMARIES|PROGRAM_VALUE_KIND|FUNCTION_REACHABILITY)_ANALYSIS/,
			);
			expect(source).not.toMatch(/programFlow\.refresh/);
		}
		expect(owner.match(/programFlow\.refresh/g)).toHaveLength(1);
		expect(owner.match(/programFlowView\(/g)).toHaveLength(4);
		const reachability = readFileSync(
			new URL("../src/compiler/core/core-ir-reachability.ts", import.meta.url),
			"utf8",
		);
		const callTargets = readFileSync(
			new URL("../src/compiler/core/core-ir-call-targets.ts", import.meta.url),
			"utf8",
		);
		const valueKinds = readFileSync(
			new URL("../src/compiler/core/core-ir-value-kinds.ts", import.meta.url),
			"utf8",
		);
		expect(owner).toMatch(/programFlow\.solveCallTargets\(/);
		expect(engine).toMatch(/solveCallTargets<.*CoreProgramFlowCallTargets/s);
		expect(callTargets).toMatch(
			/new CoreProgramFlowEngine\(program\)\.solveCallTargets\(/,
		);
		expect(callTargets).not.toMatch(
			/solveCoreProgramFlowFunctions|dependencyQueue|updateCoreCallGraph/,
		);
		expect(owner).toMatch(/programFlow\.solveValueKinds\(/);
		expect(engine).toMatch(/solveValueKinds<.*CoreProgramFlowTargetIndex/s);
		expect(valueKinds).toMatch(/new CoreProgramFlowEngine\(program\)\.solveValueKinds\(/);
		expect(valueKinds).not.toMatch(
			/solveCoreProgramFlowSccs|\.solveSccs\(|activeSccs|pendingFunctionSccs/,
		);
		expect(owner).toMatch(/programFlow\.solveReachability\(/);
		expect(engine).toMatch(/solveReachability<.*CoreProgramFlowTargetIndex/s);
		expect(reachability).toMatch(
			/new CoreProgramFlowEngine\(program\)\.solveReachability\(/,
		);
		expect(reachability).not.toMatch(/solveCoreProgramFlowSccs|while\s*\(|pending/);
	});

	it("deduplicates dirty functions within an immutable journal epoch", () => {
		const program = analysisProgram();
		const first = appendLeaf(program);
		appendLeaf(program);
		const report = new CoreOptimizationReportBuilder(program, "counters");
		const engine = new CoreProgramFlowEngine(program, report);
		const flow = engine.refresh(CORE_PROGRAM_FLOW_ALL_DIMENSIONS);

		expect(flow.dirtyFunctionCount).toBe(2);
		const firstEdit = CoreEditor.open(program, first.function);
		firstEdit.configureFunction({ isAsync: true });
		firstEdit.commit();
		const secondEdit = CoreEditor.open(program, first.function);
		secondEdit.configureFunction({ isGenerator: true });
		secondEdit.commit();
		engine.refresh(CORE_PROGRAM_FLOW_ALL_DIMENSIONS);

		expect(flow.dirtyFunctionCount).toBe(1);
		expect(flow.dirtyFunctionAt(0)).toBe(first.function);
		expect(
			report.finish(program, { directEntries: [], specializations: [] }).counters,
		).toMatchObject({
			programFlowJournalEntries: 4,
			programFlowDirtyFunctions: 3,
			programFlowTargetWakeups: 3,
			programFlowSummaryWakeups: 3,
			programFlowValueKindWakeups: 3,
			programFlowReachabilityWakeups: 3,
		});
	});

	it("does not wake value kinds for an effect-only change", () => {
		const dimensions = coreProgramFlowDimensionsForDomains(CORE_PROGRAM_FLOW_MEMORY);

		expect(dimensions & CORE_PROGRAM_FLOW_EFFECTS).toBe(CORE_PROGRAM_FLOW_EFFECTS);
		expect(dimensions & CORE_PROGRAM_FLOW_RETURN_KIND).toBe(0);
	});

	it("coalesces dimension wakeups on the shared SCC worklist", () => {
		const program = analysisProgram();
		const first = appendLeaf(program);
		const second = appendLeaf(program);
		const engine = new CoreProgramFlowEngine(program);
		const topology = engine.topology(
			updateCoreCallGraph(undefined, [first.function, second.function], []),
		);
		const scc = topology.owner.get(first.function);
		const transfers: Array<number> = [];

		const statistics = engine.solveSccs(
			topology,
			[
				{ scc, dimensions: CORE_PROGRAM_FLOW_EFFECTS },
				{ scc, dimensions: CORE_PROGRAM_FLOW_RETURN_KIND },
			],
			(_scc, dimensions) => transfers.push(dimensions),
		);

		expect(transfers).toEqual([
			CORE_PROGRAM_FLOW_EFFECTS | CORE_PROGRAM_FLOW_RETURN_KIND,
		]);
		expect(statistics).toEqual({ pops: 1, wakeups: 1 });
	});

	it("does not rebuild value kinds for an effect-only edit", () => {
		const program = analysisProgram();
		const leaf = appendLeaf(program);
		const report = new CoreOptimizationReportBuilder(program, "counters");
		const manager = new CoreAnalysisManager(program, programAnalysisContext(), report);
		const first = manager.get(CORE_PROGRAM_FLOW_ANALYSIS, { scope: "program" });
		const editor = CoreEditor.open(program, leaf.function);
		const proof = editor.addFact({
			kind: "effect-only",
			value: true,
			claims: [],
			validity: { kind: "summary", digest: "effect-only" },
			obligations: [],
			origin: "test",
		});
		editor.setInstructionEffectRefinement(leaf.valueInstruction, {
			effects: CORE_NO_EFFECTS,
			proof,
		});
		editor.commit();

		const second = manager.get(CORE_PROGRAM_FLOW_ANALYSIS, { scope: "program" });

		expect(second.targets).toBe(first.targets);
		expect(second.valueKinds).toBe(first.valueKinds);
		expect(second.reachability).toBe(first.reachability);
		expect(second.summaries).not.toBe(first.summaries);
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

	it("extracts local transfers from live instructions only", () => {
		const program = analysisProgram();
		const builder = new CoreFunctionBuilder(program, {
			metadata: { sourcePath: "/entry.js" },
		});
		const entry = builder.createBlock();
		const [result] = builder.appendInstruction(entry, "createUndefined", []);
		builder.appendInstruction(entry, "createUndefined", []);
		const [, unused] = builder.bodyInstructionIds(entry);
		builder.setTerminator(entry, { kind: "return", value: result! });
		const { function: functionId } = builder.finish(entry);
		const fn = program.function(functionId);
		const editor = CoreEditor.open(program, functionId);
		editor.removeInstruction(unused!);
		editor.commit();

		const transfers = extractCoreProgramFlowLocalTransfers(program, fn);

		expect(transfers.instructionVisits).toBe([...fn.instructionIds()].length);
		expect(transfers.instructionVisits).toBeLessThan(fn.instructionCapacity);
	});
});
