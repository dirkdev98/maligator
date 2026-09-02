import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import {
	CORE_CALLEE_TARGETS_ANY_SCRIPT,
	CORE_CALLEE_TARGETS_BOTTOM,
	CORE_CALLEE_TARGETS_OPAQUE,
	CORE_CALLEE_TARGET_CAP,
	coreCalleeTargetsAreOpen,
	coreCalleeTargetsFunction,
	coreCalleeTargetsIsBottom,
	coreCalleeTargetsSingleFunction,
	joinCoreCalleeTargets,
} from "../src/compiler/core/core-ir-call-targets.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CORE_CALL_GRAPH_ANALYSIS } from "../src/compiler/core/core-program-flow-analysis.ts";
import {
	inspectCoreBlockParameters,
	inspectCoreInstructionResults,
} from "./helpers/core-inspection.ts";
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
			targets = joinCoreCalleeTargets(targets, coreCalleeTargetsFunction(index));
		}
		expect(targets.functions).toEqual([0, 1, 2, 3]);
		expect(coreCalleeTargetsAreOpen(targets)).toBe(false);
		const widened = joinCoreCalleeTargets(
			targets,
			coreCalleeTargetsFunction(CORE_CALLEE_TARGET_CAP),
		);
		expect(widened).toMatchObject({ functions: [], anyScript: true });
		expect(joinCoreCalleeTargets(widened, coreCalleeTargetsFunction(0))).toEqual(widened);
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
			exactCallEdges: 1,
			wildcardCallSites: 0,
			wildcardCallers: 0,
			opaqueCallSites: 0,
			updatedCallSites: 1,
		});
		expect(first.graph.exactCallers(1 as never)).toEqual([caller.function]);

		const editor = CoreEditor.open(program, caller.function);
		editor.replaceInstruction(caller.createFunctionInstruction, "createFunction", [], {
			attributes: { functionIndex: 2 },
		});
		editor.commit();
		const second = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
		expect(second.statistics).toMatchObject({
			functionsAnalyzed: 1,
			functionsReused: 2,
			updatedCallSites: 1,
		});
		expect(second.graph.exactCallers(1 as never)).toEqual([]);
		expect(second.graph.exactCallers(2 as never)).toEqual([caller.function]);
		expect(
			second.site(`${caller.function}:${caller.callInstruction}`)?.targets.functions,
		).toEqual([2]);
	});

	it("preserves unrelated call indexes across an isolated body edit", () => {
		const program = analysisProgram();
		const caller = appendCaller(program, 1);
		const leaf = appendLeaf(program);
		appendCaller(program, 3);
		appendLeaf(program);
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const first = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
		const outgoing = first.outgoing(caller.function);
		const reverse = first.graph.exactCallers(1 as never);

		const editor = CoreEditor.open(program, leaf.function);
		editor.replaceInstruction(leaf.valueInstruction, "createNull", []);
		editor.commit();
		const second = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });

		expect(second.outgoing(caller.function)).toBe(outgoing);
		expect(second.graph.exactCallers(1 as never)).toBe(reverse);
		expect([...second.changedCallSites]).toEqual([]);
		expect([...second.changedEdgeCallers]).toEqual([]);
		expect(second.statistics).toMatchObject({
			functionsAnalyzed: 1,
			functionsReused: 3,
			accessFunctionsScanned: 1,
			propertyAggregateUpdates: 0,
			cellAggregateUpdates: 0,
			callSiteIndexUpdates: 0,
		});
	});

	it("keeps the call graph cached across representation and source-only edits", () => {
		const program = analysisProgram();
		appendCaller(program, 1);
		const leaf = appendLeaf(program);
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const first = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });

		const representation = CoreEditor.open(program, leaf.function);
		const [value] = inspectCoreInstructionResults(
			program.function(leaf.function),
			leaf.valueInstruction,
		);
		expect(value).toBeDefined();
		representation.setValueRepresentation(value!, "f64");
		representation.commit();
		const afterRepresentation = manager.get(CORE_CALL_GRAPH_ANALYSIS, {
			scope: "program",
		});

		const source = CoreEditor.open(program, leaf.function);
		source.appendSourcePositions([{ line: 1, column: 1 }]);
		source.commit();
		const afterSource = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });

		expect(afterRepresentation).toBe(first);
		expect(afterSource).toBe(first);
	});

	it("revisits only dependent blocks when a loop adds a callee target", () => {
		const program = analysisProgram();
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const header = builder.createBlock([{ representation: "boxed" }]);
		const body = builder.createBlock();
		const exit = builder.createBlock();
		const [initial] = builder.appendInstruction(entry, "createFunction", [], {
			attributes: { functionIndex: 1 },
		});
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: header, arguments: [initial!] },
		});
		const callee = inspectCoreBlockParameters(builder, header)[0]!.value;
		const [receiver] = builder.appendInstruction(header, "createUndefined", []);
		builder.appendInstruction(header, "call", [callee, receiver!]);
		const [, call] = builder.bodyInstructionIds(header);
		const [condition] = builder.appendInstruction(header, "createBoolean", [], {
			attributes: { value: true },
		});
		builder.setTerminator(header, {
			kind: "branch",
			condition: condition!,
			consequent: { block: body, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		const [backedge] = builder.appendInstruction(body, "createFunction", [], {
			attributes: { functionIndex: 2 },
		});
		builder.setTerminator(body, {
			kind: "jump",
			edge: { block: header, arguments: [backedge!] },
		});
		const [result] = builder.appendInstruction(exit, "createUndefined", []);
		builder.setTerminator(exit, { kind: "return", value: result! });
		const caller = builder.finish(entry).function;
		appendLeaf(program);
		appendLeaf(program);
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const first = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
		const second = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
		expect(second).toBe(first);
		expect(second.site(`${caller}:${call!}`)?.targets).toMatchObject({
			functions: [1, 2],
			anyScript: false,
			opaque: false,
		});
	});

	it("propagates a closed-cell target edit only to dependent readers", () => {
		const program = analysisProgram();
		const writer = new CoreFunctionBuilder(program);
		const writerEntry = writer.createBlock();
		const [stored] = writer.appendInstruction(writerEntry, "createFunction", [], {
			attributes: { functionIndex: 2 },
		});
		writer.appendInstruction(writerEntry, "storeGlobal", [stored!], {
			outputCount: 0,
			attributes: { index: 0 },
		});
		const [writerResult] = writer.appendInstruction(writerEntry, "createUndefined", []);
		const [createFunctionInstruction] = writer.bodyInstructionIds(writerEntry);
		writer.setTerminator(writerEntry, { kind: "return", value: writerResult! });
		const writerFunction = writer.finish(writerEntry).function;

		const caller = new CoreFunctionBuilder(program);
		const callerEntry = caller.createBlock();
		const [callee] = caller.appendInstruction(callerEntry, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		const [receiver] = caller.appendInstruction(callerEntry, "createUndefined", []);
		const [result] = caller.appendInstruction(callerEntry, "call", [callee!, receiver!]);
		const [, , callInstruction] = caller.bodyInstructionIds(callerEntry);
		caller.setTerminator(callerEntry, { kind: "return", value: result! });
		const callerFunction = caller.finish(callerEntry).function;
		appendLeaf(program);
		appendLeaf(program);

		const baseContext = programAnalysisContext();
		const manager = new CoreAnalysisManager(
			program,
			{
				...baseContext,
				data: { ...baseContext.data, singleAssignmentGlobalSlots: [0] },
			},
			new CoreOptimizationReportBuilder(program),
		);
		const first = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
		expect(
			first.site(`${callerFunction}:${callInstruction!}`)?.targets.functions,
		).toEqual([2]);

		const editor = CoreEditor.open(program, writerFunction);
		editor.replaceInstruction(createFunctionInstruction!, "createFunction", [], {
			attributes: { functionIndex: 3 },
		});
		editor.commit();
		const second = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
		expect(second.statistics).toMatchObject({
			functionsAnalyzed: 2,
			functionsReused: 2,
			updatedCallSites: 1,
		});
		expect(
			second.site(`${callerFunction}:${callInstruction!}`)?.targets.functions,
		).toEqual([3]);
		expect(second.graph.exactCallers(2 as never)).toEqual([]);
		expect(second.graph.exactCallers(3 as never)).toEqual([callerFunction]);
	});

	it("updates one global-store aggregate without rebuilding unrelated slots", () => {
		const program = analysisProgram();
		const firstWriter = new CoreFunctionBuilder(program);
		const firstEntry = firstWriter.createBlock();
		const [firstStored] = firstWriter.appendInstruction(
			firstEntry,
			"createFunction",
			[],
			{ attributes: { functionIndex: 2 } },
		);
		firstWriter.appendInstruction(firstEntry, "storeGlobal", [firstStored!], {
			outputCount: 0,
			attributes: { index: 0 },
		});
		const [firstResult] = firstWriter.appendInstruction(
			firstEntry,
			"createUndefined",
			[],
		);
		const firstCreate = firstWriter.bodyInstructionIds(firstEntry)[0]!;
		firstWriter.setTerminator(firstEntry, { kind: "return", value: firstResult! });
		const firstFunction = firstWriter.finish(firstEntry).function;

		const secondWriter = new CoreFunctionBuilder(program);
		const secondEntry = secondWriter.createBlock();
		const [secondStored] = secondWriter.appendInstruction(
			secondEntry,
			"createFunction",
			[],
			{ attributes: { functionIndex: 3 } },
		);
		secondWriter.appendInstruction(secondEntry, "storeGlobal", [secondStored!], {
			outputCount: 0,
			attributes: { index: 1 },
		});
		const [secondResult] = secondWriter.appendInstruction(
			secondEntry,
			"createUndefined",
			[],
		);
		secondWriter.setTerminator(secondEntry, {
			kind: "return",
			value: secondResult!,
		});
		secondWriter.finish(secondEntry);
		appendLeaf(program);
		appendLeaf(program);
		appendLeaf(program);
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const first = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
		const unrelated = first.globalStoreTargets(1);

		const editor = CoreEditor.open(program, firstFunction);
		editor.replaceInstruction(firstCreate, "createFunction", [], {
			attributes: { functionIndex: 4 },
		});
		editor.commit();
		const second = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });

		expect(second.globalStoreTargets(0).functions).toEqual([4]);
		expect(second.globalStoreTargets(1)).toBe(unrelated);
		expect(second.statistics.globalStoreAggregateUpdates).toBe(2);
	});

	it("keeps a guarded target for a known function-object property", () => {
		const program = analysisProgram();
		const setup = new CoreFunctionBuilder(program);
		const setupEntry = setup.createBlock();
		const [receiverFunction] = setup.appendInstruction(setupEntry, "createFunction", [], {
			attributes: { functionIndex: 2 },
		});
		const [key] = setup.appendInstruction(setupEntry, "createString", [], {
			attributes: { stringIndex: 7 },
		});
		const [propertyFunction] = setup.appendInstruction(setupEntry, "createFunction", [], {
			attributes: { functionIndex: 3 },
		});
		setup.appendInstruction(
			setupEntry,
			"defineProperty",
			[receiverFunction!, key!, propertyFunction!],
			{ outputCount: 0 },
		);
		setup.appendInstruction(setupEntry, "storeGlobal", [receiverFunction!], {
			outputCount: 0,
			attributes: { index: 0 },
		});
		const [setupResult] = setup.appendInstruction(setupEntry, "createUndefined", []);
		const propertyCreate = setup.bodyInstructionIds(setupEntry)[2]!;
		setup.setTerminator(setupEntry, { kind: "return", value: setupResult! });
		const setupFunction = setup.finish(setupEntry).function;

		const caller = new CoreFunctionBuilder(program);
		const callerEntry = caller.createBlock();
		const [receiver] = caller.appendInstruction(callerEntry, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		const [callee] = caller.appendInstruction(
			callerEntry,
			"loadPropertyStatic",
			[receiver!],
			{ attributes: { stringIndex: 7 } },
		);
		const [result] = caller.appendInstruction(callerEntry, "call", [callee!, receiver!]);
		const call = caller.bodyInstructionIds(callerEntry)[2]!;
		caller.setTerminator(callerEntry, { kind: "return", value: result! });
		const callerFunction = caller.finish(callerEntry).function;
		appendLeaf(program);
		appendLeaf(program);
		appendLeaf(program);

		const baseContext = programAnalysisContext();
		const manager = new CoreAnalysisManager(
			program,
			{
				...baseContext,
				data: { ...baseContext.data, singleAssignmentGlobalSlots: [0] },
			},
			new CoreOptimizationReportBuilder(program),
		);
		const first = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
		const targets = first.site(`${callerFunction}:${call}`)?.targets;
		expect(targets).toMatchObject({
			functions: [3],
			anyScript: false,
			opaque: true,
		});

		const editor = CoreEditor.open(program, setupFunction);
		editor.replaceInstruction(propertyCreate, "createFunction", [], {
			attributes: { functionIndex: 4 },
		});
		editor.commit();
		const second = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
		expect(second.statistics).toMatchObject({
			functionsAnalyzed: 2,
			functionsReused: 3,
			updatedCallSites: 1,
		});
		expect(second.site(`${callerFunction}:${call}`)?.targets).toMatchObject({
			functions: [4],
			anyScript: false,
			opaque: true,
		});
		expect(second.graph.exactCallers(3 as never)).toEqual([]);
		expect(second.graph.exactCallers(4 as never)).toEqual([callerFunction]);
	});

	it("does not narrow an unknown static property away from script functions", () => {
		const program = analysisProgram();
		const caller = new CoreFunctionBuilder(program);
		const entry = caller.createBlock();
		const [receiver] = caller.appendInstruction(entry, "loadGlobal", [], {
			attributes: { index: 1 },
		});
		const [callee] = caller.appendInstruction(entry, "loadPropertyStatic", [receiver!], {
			attributes: { stringIndex: 9 },
		});
		const [result] = caller.appendInstruction(entry, "call", [callee!, receiver!]);
		const call = caller.bodyInstructionIds(entry)[2]!;
		caller.setTerminator(entry, { kind: "return", value: result! });
		const callerFunction = caller.finish(entry).function;
		appendLeaf(program);

		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const graph = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
		expect(graph.site(`${callerFunction}:${call}`)?.targets).toMatchObject({
			functions: [],
			anyScript: true,
			opaque: true,
		});
		expect(graph.statistics).toMatchObject({
			exactCallEdges: 0,
			wildcardCallSites: 1,
			wildcardCallers: 1,
			opaqueCallSites: 1,
		});
	});
});
