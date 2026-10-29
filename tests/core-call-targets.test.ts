import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import {
	CORE_CALLEE_TARGETS_ANY_SCRIPT,
	CORE_CALLEE_TARGETS_BOTTOM,
	CORE_CALLEE_TARGETS_OPAQUE,
	CORE_CALLEE_TARGET_CAP,
	coreCalleeTargetsAreOpen,
	coreCalleeTargetsCallability,
	coreCalleeTargetsEqual,
	coreCalleeTargetsFunction,
	coreCalleeTargetsIsBottom,
	coreCalleeTargetsSingleFunction,
	joinCoreCalleeTargets,
} from "../src/compiler/core/core-callee-targets.ts";
import type { CoreCalleeTargets } from "../src/compiler/core/core-callee-targets.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { verifyCoreProgram } from "../src/compiler/core/core-ir-verifier.ts";
import { coreFunctionId } from "../src/compiler/core/core-ir.ts";
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
	it.each(["call", "callSpread", "callSpreadIterable"])(
		"carries a factory's finite identities through forwarding %s completions",
		(opcode) => {
			const program = analysisProgram();
			const leaf = appendLeaf(program),
				factory = appendLeaf(program);
			const edit = CoreEditor.open(program, factory.function);
			edit.replaceInstruction(factory.valueInstruction, "createFunction", [], {
				attributes: { functionIndex: leaf.function },
			});
			edit.commit();
			const middle = appendCaller(program, factory.function);
			const outer = appendCaller(program, middle.function);
			if (opcode !== "call") {
				const caller = program.function(outer.function);
				const instruction = outer.callInstruction;
				const start = caller.kernel.instructionOperandStart(instruction);
				const edit = CoreEditor.open(program, outer.function);
				const list = edit.insertInstruction(
					caller.instructionBlock(instruction),
					instruction,
					"createArray",
					[],
					{ attributes: { length: 0 } },
				).outputs[0]!;
				edit.replaceInstruction(instruction, opcode, [
					caller.kernel.operandAt(start),
					caller.kernel.operandAt(start + 1),
					list,
				]);
				edit.commit();
			}
			const manager = new CoreAnalysisManager(
				program,
				programAnalysisContext(),
				new CoreOptimizationReportBuilder(program),
			);
			const graph = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
			const fn = program.function(outer.function);
			const result = fn.kernel.resultAt(
				fn.kernel.instructionResultStart(outer.callInstruction),
			);
			expect(graph.targets(outer.function, result)).toEqual(
				coreCalleeTargetsFunction(leaf.function),
			);
		},
	);

	it("withdraws and rediscovers mutually recursive return facts without keeping a prior cycle alive", () => {
		const program = analysisProgram();
		const first = appendLeaf(program),
			second = appendLeaf(program);
		const forward = appendCaller(program, program.functionCapacity + 1);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock(),
			base = builder.createBlock(),
			recursive = builder.createBlock();
		const [condition] = builder.appendInstruction(entry, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition: condition!,
			consequent: { block: base, arguments: [] },
			alternate: { block: recursive, arguments: [] },
		});
		const [value] = builder.appendInstruction(base, "createFunction", [], {
			attributes: { functionIndex: first.function },
		});
		const baseInstruction = builder.bodyInstructionIds(base)[0]!;
		builder.setTerminator(base, { kind: "return", value: value! });
		const [callee] = builder.appendInstruction(recursive, "loadGlobal", [], {
			attributes: { index: 2 },
		});
		const recursiveCallee = builder.bodyInstructionIds(recursive)[0]!;
		const [receiver] = builder.appendInstruction(recursive, "createUndefined", []);
		const [result] = builder.appendInstruction(recursive, "call", [callee!, receiver!]);
		builder.setTerminator(recursive, { kind: "return", value: result! });
		const factory = builder.finish(entry).function;
		const outer = appendCaller(program, forward.function);
		const fn = program.function(outer.function);
		const output = fn.kernel.resultAt(
			fn.kernel.instructionResultStart(outer.callInstruction),
		);
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const targets = () =>
			manager
				.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" })
				.targets(outer.function, output);
		expect(coreCalleeTargetsCallability(targets())).toBeUndefined();
		const closeCycle = CoreEditor.open(program, factory);
		closeCycle.replaceInstruction(recursiveCallee, "createFunction", [], {
			attributes: { functionIndex: forward.function },
		});
		closeCycle.commit();
		expect(targets()).toEqual(coreCalleeTargetsFunction(first.function));
		const unknown = CoreEditor.open(program, factory);
		unknown.replaceInstruction(baseInstruction, "loadGlobal", [], {
			attributes: { index: 1 },
		});
		unknown.commit();
		expect(coreCalleeTargetsCallability(targets())).toBeUndefined();
		const known = CoreEditor.open(program, factory);
		known.replaceInstruction(baseInstruction, "createFunction", [], {
			attributes: { functionIndex: second.function },
		});
		known.commit();
		expect(targets()).toEqual(coreCalleeTargetsFunction(second.function));
		const unchanged = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
		expect(manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" })).toBe(unchanged);
	});

	it("preserves callability after widening identities and withholds it for mixed or empty targets", () => {
		expect(coreCalleeTargetsCallability(CORE_CALLEE_TARGETS_BOTTOM)).toBeUndefined();
		expect(coreCalleeTargetsCallability(CORE_CALLEE_TARGETS_OPAQUE)).toBeUndefined();
		const opaqueCallable = { ...CORE_CALLEE_TARGETS_OPAQUE, nonCallable: false };
		expect(coreCalleeTargetsCallability(opaqueCallable)).toBe(true);
		expect(coreCalleeTargetsAreOpen(opaqueCallable)).toBe(true);
		expect(coreCalleeTargetsSingleFunction(opaqueCallable)).toBeUndefined();
		expect(coreCalleeTargetsCallability(CORE_CALLEE_TARGETS_ANY_SCRIPT)).toBe(true);
		expect(coreCalleeTargetsCallability(coreCalleeTargetsFunction(0))).toBe(true);
		expect(
			coreCalleeTargetsCallability({ ...CORE_CALLEE_TARGETS_BOTTOM, nonCallable: true }),
		).toBe(false);
		expect(
			coreCalleeTargetsCallability({
				...CORE_CALLEE_TARGETS_ANY_SCRIPT,
				nonCallable: true,
			}),
		).toBeUndefined();
		expect(
			coreCalleeTargetsCallability({
				...coreCalleeTargetsFunction(0),
				nonCallable: true,
			}),
		).toBeUndefined();
	});
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

	it("unions overlapping finite sets without changing independent callable flags", () => {
		const sets = [[], [0], [1, 3], [0, 2, 3], [0, 1, 2, 3], [1, 2, 3, 4]];
		const targets: Array<CoreCalleeTargets> = [];
		for (const functions of sets)
			for (const opaque of [false, true])
				for (const nonCallable of [false, true])
					targets.push(
						Object.freeze({
							functions: Object.freeze(functions.map(coreFunctionId)),
							anyScript: false,
							opaque,
							nonCallable,
						}),
					);
		for (const left of targets)
			for (const right of targets) {
				const functions = [...new Set([...left.functions, ...right.functions])].sort(
					(first, second) => first - second,
				);
				const anyScript = functions.length > CORE_CALLEE_TARGET_CAP;
				const expected = {
					functions: anyScript ? [] : functions,
					anyScript,
					opaque: left.opaque || right.opaque,
					nonCallable: left.nonCallable || right.nonCallable,
				};
				const joined = joinCoreCalleeTargets(left, right);
				expect(joined).toEqual(expected);
				expect(coreCalleeTargetsEqual(joined, expected)).toBe(true);
				expect(coreCalleeTargetsEqual(left, right)).toBe(
					left.opaque === right.opaque &&
						left.nonCallable === right.nonCallable &&
						JSON.stringify(left.functions) === JSON.stringify(right.functions),
				);
			}
	});

	it("retains open return provenance through equal and bottom joins", () => {
		const returned = Object.freeze({
			...coreCalleeTargetsFunction(3),
			anyScript: true,
			opaque: true,
			nonCallable: true,
		});
		expect(joinCoreCalleeTargets(returned, { ...returned })).toBe(returned);
		expect(joinCoreCalleeTargets(CORE_CALLEE_TARGETS_BOTTOM, returned)).toBe(returned);
		expect(joinCoreCalleeTargets(returned, CORE_CALLEE_TARGETS_BOTTOM)).toBe(returned);
		expect(joinCoreCalleeTargets(returned, coreCalleeTargetsFunction(2))).toEqual({
			functions: [],
			anyScript: true,
			opaque: true,
			nonCallable: true,
		});
		expect(returned.functions).toEqual([3]);
	});
});

describe("incremental Core call graph", () => {
	it("transports opaque callable arguments through complete caller bounds without certifying dispatch", () => {
		const program = analysisProgram();
		const root = new CoreFunctionBuilder(program);
		const entry = root.createBlock();
		const [helper] = root.appendInstruction(entry, "createFunction", [], {
			attributes: { functionIndex: 1 },
		});
		const [receiver] = root.appendInstruction(entry, "createUndefined", []);
		const [builtin] = root.appendInstruction(entry, "loadIntrinsic", [], {
			attributes: { intrinsic: "Function" },
		});
		const [result] = root.appendInstruction(entry, "call", [
			helper!,
			receiver!,
			builtin!,
		]);
		root.setTerminator(entry, { kind: "return", value: result! });
		root.finish(entry);

		const callee = new CoreFunctionBuilder(program, { parameterCount: 1 });
		const calleeEntry = callee.createBlock([{}]);
		const parameter = callee.blockParameterValue(calleeEntry, 0);
		const [thisValue] = callee.appendInstruction(calleeEntry, "createUndefined", []);
		const [called] = callee.appendInstruction(calleeEntry, "call", [
			parameter,
			thisValue!,
		]);
		const call = callee.bodyInstructionIds(calleeEntry).at(-1)!;
		callee.setTerminator(calleeEntry, { kind: "return", value: called! });
		const fn = callee.finish(calleeEntry).function;
		verifyCoreProgram(program);
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const graph = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
		expect(coreCalleeTargetsCallability(graph.targets(fn, parameter))).toBe(true);
		expect(graph.site(fn, call)?.open).toBe(true);
		expect(
			coreCalleeTargetsSingleFunction(graph.site(fn, call)!.targets),
		).toBeUndefined();
	});

	it("withdraws and rediscovers invocation targets after an unknown return", () => {
		const program = analysisProgram(),
			factory = appendLeaf(program),
			caller = appendCaller(program, factory.function),
			callback = appendLeaf(program);
		const fn = program.function(caller.function),
			result = fn.kernel.resultAt(
				fn.kernel.instructionResultStart(caller.callInstruction),
			);
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const read = () =>
			manager
				.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" })
				.targets(caller.function, result);
		expect(coreCalleeTargetsCallability(read())).toBe(false);
		const unknown = CoreEditor.open(program, factory.function);
		unknown.replaceInstruction(factory.valueInstruction, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		unknown.commit();
		expect(coreCalleeTargetsCallability(read())).toBeUndefined();
		const known = CoreEditor.open(program, factory.function);
		known.replaceInstruction(factory.valueInstruction, "createFunction", [], {
			attributes: { functionIndex: callback.function },
		});
		known.commit();
		expect(read().functions).toEqual([callback.function]);
		expect(coreCalleeTargetsCallability(read())).toBe(true);
	});

	it.each(["guardFunctionIndex", "guardBaseConstructorLayout"])(
		"classifies %s's Boolean result independently of its callee operand",
		(opcode) => {
			const program = analysisProgram(),
				leaf = appendLeaf(program);
			const builder = new CoreFunctionBuilder(program),
				entry = builder.createBlock();
			const callee = builder.appendInstruction(entry, "createFunction", [], {
				attributes: { functionIndex: leaf.function },
			})[0]!;
			const guard = builder.appendInstruction(entry, opcode, [callee], {
				attributes: { functionIndex: leaf.function, keyStringIndices: [] },
				outputRepresentations: ["boolean"],
			})[0]!;
			builder.setTerminator(entry, { kind: "return", value: guard });
			const fn = builder.finish(entry).function;
			const manager = new CoreAnalysisManager(
				program,
				programAnalysisContext(),
				new CoreOptimizationReportBuilder(program),
			);
			const targets = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
			expect(targets.targets(fn, guard)).toMatchObject({
				functions: [],
				anyScript: false,
				opaque: false,
				nonCallable: true,
			});
		},
	);

	it.each([
		[false, false],
		[true, false],
		[false, true],
		[true, true],
	] as const)(
		"keeps body return targets separate from the invocation result (async=%s, generator=%s)",
		(isAsync, isGenerator) => {
			const program = analysisProgram(),
				leaf = appendLeaf(program);
			const builder = new CoreFunctionBuilder(program, { isAsync, isGenerator }),
				entry = builder.createBlock();
			const returned = builder.appendInstruction(entry, "createFunction", [], {
				attributes: { functionIndex: leaf.function },
			})[0]!;
			builder.setTerminator(entry, { kind: "return", value: returned });
			const factory = builder.finish(entry).function;
			const caller = appendCaller(program, factory),
				fn = program.function(caller.function);
			const result = fn.kernel.resultAt(
				fn.kernel.instructionResultStart(caller.callInstruction),
			);
			const manager = new CoreAnalysisManager(
				program,
				programAnalysisContext(),
				new CoreOptimizationReportBuilder(program),
			);
			const targets = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
			expect(targets.returnTargets(factory).functions).toEqual([leaf.function]);
			expect(targets.targets(caller.function, result)).toMatchObject({
				functions: isAsync || isGenerator ? [] : [leaf.function],
				anyScript: false,
				opaque: false,
				nonCallable: isAsync || isGenerator,
			});
		},
	);

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
			second.site(caller.function, caller.callInstruction)?.targets.functions,
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

	it("propagates guarded closure returns and invalidates dependent callers", () => {
		const program = analysisProgram();
		const factory = new CoreFunctionBuilder(program);
		const factoryEntry = factory.createBlock();
		const [created] = factory.appendInstruction(factoryEntry, "createFunction", [], {
			attributes: { functionIndex: 2 },
		});
		const [createInstruction] = factory.bodyInstructionIds(factoryEntry);
		factory.setTerminator(factoryEntry, { kind: "return", value: created! });
		const factoryFunction = factory.finish(factoryEntry).function;

		const caller = new CoreFunctionBuilder(program);
		const callerEntry = caller.createBlock();
		const [factoryValue] = caller.appendInstruction(callerEntry, "createFunction", [], {
			attributes: { functionIndex: factoryFunction },
		});
		caller.appendInstruction(callerEntry, "storeGlobal", [factoryValue!], {
			attributes: { index: 0 },
		});
		const [loadedFactory] = caller.appendInstruction(callerEntry, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		const [receiver] = caller.appendInstruction(callerEntry, "createUndefined", []);
		const [returnedFunction] = caller.appendInstruction(callerEntry, "call", [
			loadedFactory!,
			receiver!,
		]);
		const [result] = caller.appendInstruction(callerEntry, "call", [
			returnedFunction!,
			receiver!,
		]);
		const [, , , , factoryCall, returnedCall] = caller.bodyInstructionIds(callerEntry);
		caller.setTerminator(callerEntry, { kind: "return", value: result! });
		const callerFunction = caller.finish(callerEntry).function;
		appendLeaf(program);
		appendLeaf(program);

		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const first = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
		expect(first.site(callerFunction, factoryCall!)?.targets).toMatchObject({
			functions: [factoryFunction],
			anyScript: false,
			opaque: true,
		});
		expect(first.site(callerFunction, returnedCall!)?.targets).toEqual({
			functions: [2],
			anyScript: true,
			opaque: true,
			nonCallable: true,
		});

		const editor = CoreEditor.open(program, factoryFunction);
		editor.replaceInstruction(createInstruction!, "createFunction", [], {
			attributes: { functionIndex: 3 },
		});
		editor.commit();
		const second = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
		expect(second.statistics.functionsAnalyzed).toBe(2);
		expect(second.site(callerFunction, returnedCall!)?.targets).toEqual({
			functions: [3],
			anyScript: true,
			opaque: true,
			nonCallable: true,
		});
	});

	it("keeps isolated target rebuild work constant as unrelated functions grow", () => {
		const program = analysisProgram();
		const caller = appendCaller(program, 1);
		appendLeaf(program);
		const unrelated = Array.from({ length: 63 }, () => appendLeaf(program));
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const first = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
		const outgoing = first.outgoing(caller.function);

		const edited = unrelated.at(-1)!;
		const editor = CoreEditor.open(program, edited.function);
		editor.replaceInstruction(edited.valueInstruction, "createNull", []);
		editor.commit();
		const second = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });

		expect(second.outgoing(caller.function)).toBe(outgoing);
		expect(second.statistics).toMatchObject({
			functions: 65,
			functionsAnalyzed: 1,
			functionsReused: 64,
			accessFunctionsScanned: 1,
			propertyAggregateUpdates: 0,
			callSiteIndexUpdates: 0,
		});
	});

	it("reruns only the edited caller when the arguments it passes down a chain keep their targets", () => {
		const program = analysisProgram();
		const chainLength = 8;
		const callback = chainLength + 1;
		const root = new CoreFunctionBuilder(program);
		const rootEntry = root.createBlock();
		const [first] = root.appendInstruction(rootEntry, "createFunction", [], {
			attributes: { functionIndex: 1 },
		});
		const [receiver] = root.appendInstruction(rootEntry, "createUndefined", []);
		const receiverInstruction = root.bodyInstructionIds(rootEntry).at(-1)!;
		const [held] = root.appendInstruction(rootEntry, "createFunction", [], {
			attributes: { functionIndex: callback },
		});
		const [rootResult] = root.appendInstruction(rootEntry, "call", [
			first!,
			receiver!,
			held!,
		]);
		root.setTerminator(rootEntry, { kind: "return", value: rootResult! });
		root.finish(rootEntry);
		for (let index = 1; index <= chainLength; index++) {
			const link = new CoreFunctionBuilder(program, { parameterCount: 1 });
			const entry = link.createBlock([{}]);
			const parameter = link.blockParameterValue(entry, 0);
			const [undefinedValue] = link.appendInstruction(entry, "createUndefined", []);
			const [next] =
				index === chainLength
					? [parameter]
					: link.appendInstruction(entry, "createFunction", [], {
							attributes: { functionIndex: index + 1 },
						});
			const [result] = link.appendInstruction(
				entry,
				"call",
				index === chainLength
					? [next!, undefinedValue!]
					: [next!, undefinedValue!, parameter],
			);
			link.setTerminator(entry, { kind: "return", value: result! });
			link.finish(entry);
		}
		appendLeaf(program);
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });

		const editor = CoreEditor.open(program, coreFunctionId(0));
		editor.replaceInstruction(receiverInstruction, "createNull", []);
		editor.commit();
		const second = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });

		expect(
			second.targets(
				coreFunctionId(chainLength),
				program.function(coreFunctionId(chainLength)).kernel.functionParameter(0),
			).functions,
		).toEqual([callback]);
		expect(second.statistics.functionsAnalyzed).toBe(1);
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

	it("propagates forward uses and self-loop targets into ordinary and exceptional successors", () => {
		const program = analysisProgram();
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const loop = builder.createBlock([{}]);
		const exit = builder.createBlock([{}]);
		const handler = builder.createBlock([{ role: "exception" }, {}]);
		const [initial] = builder.appendInstruction(entry, "createFunction", [], {
			attributes: { functionIndex: 1 },
		});
		const [receiver] = builder.appendInstruction(entry, "createUndefined", []);
		const [condition] = builder.appendInstruction(entry, "createBoolean", [], {
			attributes: { value: true },
		});
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: loop, arguments: [initial!] },
		});
		const callee = builder.blockParameterValue(loop, 0);
		const [copy] = builder.appendInstruction(loop, "move", [callee]);
		const [alias] = builder.appendInstruction(loop, "move", [copy!]);
		builder.appendInstruction(loop, "call", [alias!, receiver!]);
		const loopCall = builder.bodyInstructionIds(loop).at(-1)!;
		const [backedge] = builder.appendInstruction(loop, "createFunction", [], {
			attributes: { functionIndex: 2 },
		});
		builder.setHandler(loop, handler, [callee]);
		builder.setTerminator(loop, {
			kind: "branch",
			condition: condition!,
			consequent: { block: loop, arguments: [backedge!] },
			alternate: { block: exit, arguments: [alias!] },
		});
		const [exitResult] = builder.appendInstruction(exit, "call", [
			builder.blockParameterValue(exit, 0),
			receiver!,
		]);
		const exitCall = builder.bodyInstructionIds(exit).at(-1)!;
		builder.setTerminator(exit, { kind: "return", value: exitResult! });
		const [handlerAlias] = builder.appendInstruction(handler, "move", [
			builder.blockParameterValue(handler, 1),
		]);
		const [handlerResult] = builder.appendInstruction(handler, "call", [
			handlerAlias!,
			receiver!,
		]);
		const handlerCall = builder.bodyInstructionIds(handler).at(-1)!;
		builder.setTerminator(handler, { kind: "return", value: handlerResult! });
		const caller = builder.finish(entry).function;
		appendLeaf(program);
		appendLeaf(program);
		verifyCoreProgram(program);
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const targets = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
		for (const call of [loopCall, exitCall, handlerCall])
			expect(targets.site(caller, call)?.targets).toEqual({
				functions: [1, 2],
				anyScript: false,
				opaque: false,
				nonCallable: false,
			});
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
		const [backedgeInstruction] = builder.bodyInstructionIds(body);
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
		expect(second.site(caller, call!)?.targets).toMatchObject({
			functions: [1, 2],
			anyScript: false,
			opaque: false,
		});
		const sameTarget = CoreEditor.open(program, caller);
		sameTarget.replaceInstruction(backedgeInstruction!, "createFunction", [], {
			attributes: { functionIndex: 1 },
		});
		sameTarget.commit();
		const closed = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
		expect(closed.site(caller, call!)?.open).toBe(false);
		const nonCallable = CoreEditor.open(program, caller);
		nonCallable.replaceInstruction(backedgeInstruction!, "createUndefined", []);
		nonCallable.commit();
		const guarded = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
		expect(guarded.site(caller, call!)).toMatchObject({
			open: true,
			targets: { functions: [1], anyScript: false, opaque: false, nonCallable: true },
		});
		expect(guarded.changedCallSites).toHaveLength(1);
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
		expect(first.site(callerFunction, callInstruction!)?.targets.functions).toEqual([2]);

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
		expect(second.site(callerFunction, callInstruction!)?.targets.functions).toEqual([3]);
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
		expect(second.statistics.globalStoreAggregateUpdates).toBeLessThanOrEqual(3);
	});

	it("preserves prior contribution snapshots through writer replacement and removal", () => {
		const program = analysisProgram();
		const targets = [appendLeaf(program), appendLeaf(program), appendLeaf(program)];
		const appendWriter = (slot: number, target: number) => {
			const builder = new CoreFunctionBuilder(program);
			const entry = builder.createBlock();
			const [value] = builder.appendInstruction(entry, "createFunction", [], {
				attributes: { functionIndex: target },
			});
			builder.appendInstruction(entry, "storeGlobal", [value!], {
				attributes: { index: slot },
			});
			const [create, store] = builder.bodyInstructionIds(entry);
			builder.setTerminator(entry, { kind: "return", value: value! });
			return {
				function: builder.finish(entry).function,
				entry,
				value: value!,
				create: create!,
				store: store!,
			};
		};
		const firstWriter = appendWriter(0, targets[0]!.function);
		const secondWriter = appendWriter(0, targets[1]!.function);
		appendWriter(1, targets[0]!.function);
		const forwarder = new CoreFunctionBuilder(program);
		const entry = forwarder.createBlock();
		const [loaded] = forwarder.appendInstruction(entry, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		forwarder.appendInstruction(entry, "storeGlobal", [loaded!], {
			attributes: { index: 2 },
		});
		const [receiver] = forwarder.appendInstruction(entry, "createUndefined", []);
		const [result] = forwarder.appendInstruction(entry, "call", [loaded!, receiver!]);
		const call = forwarder.bodyInstructionIds(entry)[3]!;
		forwarder.setTerminator(entry, { kind: "return", value: result! });
		const caller = forwarder.finish(entry).function;
		const context = programAnalysisContext();
		const manager = new CoreAnalysisManager(
			program,
			context,
			new CoreOptimizationReportBuilder(program),
		);
		const first = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
		const indexes = (state: typeof first) => ({
			cellWriters: state.cellWriters,
			globalStoreWriters: state.globalStoreWriters,
			cellReaders: state.cellReaders,
		});
		const firstSnapshot = structuredClone(indexes(first));
		expect(first.globalStoreTargets(0).functions).toEqual([0, 1]);
		expect(first.site(caller, call)?.targets.functions).toEqual([0, 1]);
		const checkFresh = (state: typeof first) => {
			const fresh = new CoreAnalysisManager(
				program,
				context,
				new CoreOptimizationReportBuilder(program),
			).get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
			expect(state.globalStores).toEqual(fresh.globalStores);
			expect(state.site(caller, call)).toEqual(fresh.site(caller, call));
			expect(indexes(first)).toEqual(firstSnapshot);
		};

		const replace = CoreEditor.open(program, secondWriter.function);
		replace.replaceInstruction(secondWriter.create, "createFunction", [], {
			attributes: { functionIndex: targets[2]!.function },
		});
		replace.commit();
		const second = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
		const secondSnapshot = structuredClone(indexes(second));
		expect(second.globalStoreTargets(0).functions).toEqual([0, 2]);
		expect(second.site(caller, call)?.targets.functions).toEqual([0, 2]);
		expect(second.globalStoreWriters.get(1)).toBe(first.globalStoreWriters.get(1));
		checkFresh(second);

		for (const writer of [firstWriter, secondWriter]) {
			const remove = CoreEditor.open(program, writer.function);
			remove.removeInstruction(writer.store);
			remove.commit();
			const next = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
			checkFresh(next);
			expect(indexes(second)).toEqual(secondSnapshot);
		}
		const removed = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
		expect(removed.globalStoreTargets(0)).toEqual(CORE_CALLEE_TARGETS_BOTTOM);
		expect(removed.globalStoreWriters.has(0)).toBe(false);
		expect(removed.site(caller, call)?.targets.functions).toEqual([]);
		const removedSnapshot = structuredClone(indexes(removed));
		const restore = CoreEditor.open(program, secondWriter.function);
		restore.appendInstruction(secondWriter.entry, "storeGlobal", [secondWriter.value], {
			attributes: { index: 0 },
		});
		restore.commit();
		const restored = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
		expect(restored.globalStoreTargets(0).functions).toEqual([2]);
		expect(restored.site(caller, call)?.targets.functions).toEqual([2]);
		checkFresh(restored);
		expect(indexes(second)).toEqual(secondSnapshot);
		expect(indexes(removed)).toEqual(removedSnapshot);
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
		const targets = first.site(callerFunction, call)?.targets;
		const priorWriters = structuredClone(first.propertyWriters);
		const priorReaders = structuredClone(first.propertyReaders);
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
		expect(second.site(callerFunction, call)?.targets).toMatchObject({
			functions: [4],
			anyScript: false,
			opaque: true,
		});
		expect(second.graph.exactCallers(3 as never)).toEqual([]);
		expect(second.graph.exactCallers(4 as never)).toEqual([callerFunction]);
		expect(first.propertyWriters).toEqual(priorWriters);
		expect(first.propertyReaders).toEqual(priorReaders);
	});

	it("tracks guarded global function properties through static method writes", () => {
		const program = analysisProgram();
		const setup = new CoreFunctionBuilder(program);
		const setupEntry = setup.createBlock();
		const [holder] = setup.appendInstruction(setupEntry, "createFunction", [], {
			attributes: { functionIndex: 2 },
		});
		const [first] = setup.appendInstruction(setupEntry, "createFunction", [], {
			attributes: { functionIndex: 3 },
		});
		const [second] = setup.appendInstruction(setupEntry, "createFunction", [], {
			attributes: { functionIndex: 4 },
		});
		for (const [nameStringIndex, value] of [
			[10, holder],
			[11, first],
			[12, second],
		] as const) {
			setup.appendInstruction(setupEntry, "storeGlobalProperty", [value!], {
				outputCount: 0,
				attributes: { nameStringIndex },
			});
		}
		const [loadedHolder] = setup.appendInstruction(setupEntry, "loadGlobalProperty", [], {
			attributes: { nameStringIndex: 10 },
		});
		const [loadedFirst] = setup.appendInstruction(setupEntry, "loadGlobalProperty", [], {
			attributes: { nameStringIndex: 11 },
		});
		const [loadedSecond] = setup.appendInstruction(setupEntry, "loadGlobalProperty", [], {
			attributes: { nameStringIndex: 12 },
		});
		setup.appendInstruction(
			setupEntry,
			"storePropertyStatic",
			[loadedHolder!, loadedFirst!],
			{ outputCount: 0, attributes: { stringIndex: 7 } },
		);
		setup.appendInstruction(
			setupEntry,
			"storePropertyStatic",
			[loadedHolder!, loadedSecond!],
			{ outputCount: 0, attributes: { stringIndex: 7 } },
		);
		const [setupResult] = setup.appendInstruction(setupEntry, "createUndefined", []);
		setup.setTerminator(setupEntry, { kind: "return", value: setupResult! });
		setup.finish(setupEntry);

		const caller = new CoreFunctionBuilder(program);
		const callerEntry = caller.createBlock();
		const [receiver] = caller.appendInstruction(callerEntry, "loadGlobalProperty", [], {
			attributes: { nameStringIndex: 10 },
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

		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const graph = manager.get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
		expect(graph.site(callerFunction, call)?.targets).toMatchObject({
			functions: [3, 4],
			anyScript: false,
			opaque: true,
		});
		expect(graph.graph.exactCallers(3 as never)).toEqual([callerFunction]);
		expect(graph.graph.exactCallers(4 as never)).toEqual([callerFunction]);
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
		expect(graph.site(callerFunction, call)?.targets).toMatchObject({
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
