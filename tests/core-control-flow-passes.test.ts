import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import type { CoreCompilationContext } from "../src/compiler/core/core-compilation.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { lowerSemanticProgramToCore } from "../src/compiler/core/core-frontend.ts";
import {
	CORE_CONTROL_FLOW_BUNDLE_ANALYSIS,
	buildCoreControlFlow,
} from "../src/compiler/core/core-ir-control-flow.ts";
import { coreCanonicalValueRoots } from "../src/compiler/core/core-ir-control-flow.ts";
import { analyzeCoreLocalExceptionFlows } from "../src/compiler/core/core-ir-exception-flow.ts";
import { analyzeCoreLoopInductions } from "../src/compiler/core/core-ir-loops.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import {
	CORE_NO_EFFECTS,
	CoreOpcodeRegistry,
	coreArity,
} from "../src/compiler/core/core-ir.ts";
import type { CoreValueId } from "../src/compiler/core/core-ir.ts";
import { CORE_OPTIMIZATION_OWNER } from "../src/compiler/core/core-optimization-owners.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { coreExactArrayFromCallResult } from "../src/compiler/core/core-static-values.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import type { CoreFunctionStore } from "../src/compiler/core/core-store.ts";
import { optimizeCore } from "../src/compiler/core/optimize.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { builtinWorldAssumptions } from "../src/compiler/shared/builtin-assumptions.ts";
import {
	compilerProgramFactsFromConfig,
	conservativeCompilerProgramFacts,
} from "../src/compiler/shared/compiler-facts.ts";
import {
	inspectCoreBlockParameters,
	inspectCoreInstructionResults,
	inspectCoreTerminatorPayload,
	inspectCoreValueDefinition,
	coreFunctionNamed,
	coreOperations,
} from "./helpers/core-inspection.ts";

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

const lockedMathContext: CoreCompilationContext = {
	...context,
	facts: {
		...context.facts,
		world: { ...context.facts.world, primordialPolicy: "locked" },
	},
};

const lockedArrayContext: CoreCompilationContext = {
	...context,
	facts: compilerProgramFactsFromConfig(
		resolveBuildConfig({ engine: { primordials: "locked", realms: false } }),
	),
};

function definingInstruction(fn: CoreFunctionStore, value: CoreValueId) {
	const definition = inspectCoreValueDefinition(fn, value);
	if (definition.kind !== "instruction") throw new Error("expected instruction value");
	return definition.instruction;
}

function optimizeSource(source: string, compilationContext = lockedArrayContext) {
	return optimizeCore(
		lowerSemanticProgramToCore(
			analyzeSourceAndRunSemanticAnalysis(source, "control-flow-source.js"),
			{ facts: compilationContext.facts },
		),
		{ verification: "per-pass" },
	).compilation.program;
}

function sourceLengthLoad(program: CoreProgram, functionName: string) {
	const fn = coreFunctionNamed(program, functionName);
	if (fn === undefined) throw new Error(`missing ${functionName}`);
	const load = coreOperations(fn).find(({ opcode, attributes }) => {
		if (opcode !== "loadPropertyStatic" || typeof attributes.stringIndex !== "number")
			return false;
		return (
			String.fromCodePoint(...(program.stringConstants[attributes.stringIndex] ?? [])) ===
			"length"
		);
	});
	if (load === undefined) throw new Error(`missing ${functionName} length load`);
	return { fn, load };
}

describe("Core control-flow analyses and passes", () => {
	it("defers loop products until a consumer requests them", () => {
		const ownerWork = (readLoops: boolean) => {
			const program = new CoreProgram(coreOpcodeRegistry);
			const builder = new CoreFunctionBuilder(program);
			const entry = builder.createBlock();
			const [value] = builder.appendInstruction(entry, "createUndefined", []);
			builder.setTerminator(entry, { kind: "return", value: value! });
			const functionId = builder.finish(entry).function;
			const report = new CoreOptimizationReportBuilder(program);
			const analyses = new CoreAnalysisManager(program, context, report);
			const control = analyses
				.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, {
					scope: "function",
					function: functionId,
				})
				.exceptional();
			if (readLoops) expect(control.loops).toEqual([]);
			return report.finish(program, { directEntries: [], specializations: [] }).owners[
				CORE_OPTIMIZATION_OWNER.loopsAndDominanceFrontiers
			]!.workUnits;
		};

		expect(ownerWork(false)).toBe(0);
		expect(ownerWork(true)).toBe(1);
	});

	it.each([
		{
			name: "successive diamonds",
			entry: 0,
			edges: [[1, 2], [3], [3], [4, 5], [6], [6], [7, 8], [9], [9], []],
		},
		{
			name: "nested loops and unreachable cycles",
			entry: 0,
			edges: [[1], [2, 7], [3, 4], [5], [5], [2, 6], [1], [], [9], [8]],
		},
		{
			name: "irreducible cycles",
			entry: 0,
			edges: [[1, 2], [3], [3, 5], [4], [1, 5], [2, 6], []],
		},
		{
			name: "reversed successor order and parallel edges",
			entry: 2,
			edges: [[4, 1], [3, 3], [5, 0], [6, 1], [3, 5], [4, 6], []],
		},
		{
			name: "nonzero entry and sparse reachable IDs",
			entry: 2,
			edges: [[0], [3], [1, 4], [5], [5], []],
		},
	])(
		"matches dominance with block-removal reachability for $name",
		({ entry, edges }) => {
			const program = new CoreProgram(coreOpcodeRegistry);
			const builder = new CoreFunctionBuilder(program);
			const blocks = edges.map(() => builder.createBlock());
			for (const [index, targets] of edges.entries()) {
				const block = blocks[index]!;
				const [condition] = builder.appendInstruction(block, "createBoolean", [], {
					attributes: { value: true },
				});
				if (targets.length === 0) {
					builder.setTerminator(block, { kind: "return", value: condition! });
				} else if (targets.length === 1) {
					builder.setTerminator(block, {
						kind: "jump",
						edge: { block: blocks[targets[0]!]!, arguments: [] },
					});
				} else {
					builder.setTerminator(block, {
						kind: "branch",
						condition: condition!,
						consequent: { block: blocks[targets[0]!]!, arguments: [] },
						alternate: { block: blocks[targets[1]!]!, arguments: [] },
					});
				}
			}
			const reachableWithout = (removed: number): Set<number> => {
				const pending = removed === entry ? [] : [entry];
				const visited = new Set<number>();
				for (const block of pending) {
					if (visited.has(block)) continue;
					visited.add(block);
					for (const target of edges[block]!) {
						if (target !== removed) pending.push(target);
					}
				}
				return visited;
			};
			const reachable = reachableWithout(-1);
			const avoided = blocks.map((_, block) => reachableWithout(block));
			const expectedDominates = (dominator: number, block: number): boolean =>
				reachable.has(block) && !avoided[dominator]!.has(block);
			const cfg = buildCoreControlFlow(program, builder.finish(blocks[entry]!).function);
			for (const [blockIndex, block] of blocks.entries()) {
				const strictDominators: Array<number> = [];
				for (const [dominatorIndex, dominator] of blocks.entries()) {
					const expected = expectedDominates(dominatorIndex, blockIndex);
					expect(cfg.dominates(dominator, block)).toBe(expected);
					if (expected && dominator !== block) strictDominators.push(dominatorIndex);
				}
				const parent = strictDominators.find((candidate) =>
					strictDominators.every((other) => expectedDominates(other, candidate)),
				);
				expect(cfg.immediateDominators[block]).toBe(
					parent === undefined ? null : blocks[parent],
				);
			}
		},
	);

	it("classifies a multi-entry cycle without inventing a natural loop", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{ representation: "boolean" }]);
		const left = builder.createBlock();
		const right = builder.createBlock();
		const exit = builder.createBlock();
		const condition = inspectCoreBlockParameters(builder, entry)[0]!.value;
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
			value: inspectCoreBlockParameters(builder, handler)[0]!.value,
		});
		const finished = builder.finish(entry);
		const cfg = buildCoreControlFlow(program, finished.function);
		expect(cfg.successors[entry]).toMatchObject([
			{ from: entry, to: handler, kind: "exceptional", arguments: [] },
		]);
		expect(
			analyzeCoreLocalExceptionFlows(program.function(finished.function), cfg),
		).toMatchObject([{ source: entry, handler, thrownValue: thrown }]);
	});

	it("preserves structural snapshots across effect refinement", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const normal = builder.createBlock();
		const handler = builder.createBlock([{ role: "exception" }]);
		const callee = inspectCoreBlockParameters(builder, entry)[0]!.value;
		builder.appendInstruction(entry, "call", [callee, callee]);
		builder.setHandler(entry, handler);
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: normal, arguments: [] },
		});
		builder.setTerminator(normal, { kind: "return", value: callee });
		builder.setTerminator(handler, {
			kind: "jump",
			edge: { block: normal, arguments: [] },
		});
		const functionId = builder.finish(entry).function;
		const report = new CoreOptimizationReportBuilder(program);
		const analyses = new CoreAnalysisManager(program, context, report);
		const request = { scope: "function" as const, function: functionId };
		const bundle = analyses.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, request);
		const ordinary = bundle.ordinary();
		const exceptional = bundle.exceptional();

		expect(exceptional.successors).toBe(bundle.structural.successors);
		expect(exceptional.successors[entry]![0]).toBe(ordinary.successors[entry]![0]);
		expect(exceptional.successors[normal]).toBe(ordinary.successors[normal]);
		expect(exceptional.predecessors[entry]).toBe(ordinary.predecessors[entry]);
		expect(exceptional.successors[entry]![1]).toMatchObject({
			from: entry,
			to: handler,
			kind: "exceptional",
		});

		const call = [...program.function(functionId).bodyInstructionIds(entry)][0]!;
		const editor = CoreEditor.open(program, functionId);
		const proof = editor.addFact({
			kind: "test-call-effects",
			value: true,
			claims: [{ kind: "effect", instruction: call, effects: CORE_NO_EFFECTS }],
			validity: { kind: "summary", digest: "test-call-effects" },
			obligations: [],
			origin: "test",
		});
		editor.setInstructionEffectRefinement(call, { effects: CORE_NO_EFFECTS, proof });
		const changes = editor.commit();
		expect(changes.domains).not.toContain("cfg");
		const retained = analyses.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, request);
		expect(retained).toBe(bundle);
		expect(retained.ordinary()).toBe(ordinary);
		const refinedExceptional = retained.exceptional();
		expect(refinedExceptional).not.toBe(exceptional);
		expect(refinedExceptional.successors[entry]).toHaveLength(1);
		expect(refinedExceptional.successors[entry]![0]).toBe(ordinary.successors[entry]![0]);
		expect(exceptional.instructionDominatesBlock(entry, normal)).toBe(false);
		expect(refinedExceptional.instructionDominatesBlock(entry, normal)).toBe(true);
	});

	it("does not reuse a protected-block value after an exceptional join", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const handler = builder.createBlock([{ role: "exception" }]);
		const join = builder.createBlock();
		const callee = inspectCoreBlockParameters(builder, entry)[0]!.value;
		builder.appendInstruction(entry, "call", [callee, callee]);
		const [_protectedValue] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 2 },
		});
		builder.setHandler(entry, handler);
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: join, arguments: [] },
		});
		builder.setTerminator(handler, {
			kind: "jump",
			edge: { block: join, arguments: [] },
		});
		const [joinedValue] = builder.appendInstruction(join, "createNumber", [], {
			attributes: { value: 2 },
		});
		builder.setTerminator(join, { kind: "return", value: joinedValue! });
		const function_ = builder.finish(entry).function;
		const fn = optimizeCore(
			{ program, context },
			{ verification: "per-pass" },
		).compilation.program.function(function_);
		const finalValues = [...fn.instructionIds()].filter(
			(instruction) =>
				fn.instructionKind(instruction) === "operation" &&
				fn.instructionOpcodeName(instruction) === "createNumber" &&
				fn.instructionAttributes(instruction).value === 2,
		);
		expect(finalValues).toHaveLength(1);
		const returned = [...fn.blockIds()]
			.map((block) => inspectCoreTerminatorPayload(fn, fn.blockTerminator(block)))
			.find(({ kind }) => kind === "return");
		expect(returned).toEqual({
			kind: "return",
			value: inspectCoreInstructionResults(fn, finalValues[0]!)[0],
		});
	});

	it("recognizes canonical induction ranges and loop nesting metadata", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const header = builder.createBlock([{ representation: "f64" }]);
		const latch = builder.createBlock([{ representation: "f64" }]);
		const exit = builder.createBlock();
		const [zero] = builder.appendInstruction(entry, "createF64", [], {
			attributes: { value: 0 },
			outputRepresentations: ["f64"],
		});
		const [ten] = builder.appendInstruction(entry, "createF64", [], {
			attributes: { value: 10 },
			outputRepresentations: ["f64"],
		});
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: header, arguments: [zero!] },
		});
		const counter = inspectCoreBlockParameters(builder, header)[0]!.value;
		const [condition] = builder.appendInstruction(header, "binary", [counter, ten!], {
			attributes: { operator: "<" },
			outputRepresentations: ["boolean"],
		});
		builder.setTerminator(header, {
			kind: "branch",
			condition: condition!,
			consequent: { block: latch, arguments: [counter] },
			alternate: { block: exit, arguments: [] },
		});
		const latchCounter = inspectCoreBlockParameters(builder, latch)[0]!.value;
		const [next] = builder.appendInstruction(latch, "unary", [latchCounter], {
			attributes: { operator: "increment" },
			outputRepresentations: ["f64"],
		});
		builder.setTerminator(latch, {
			kind: "jump",
			edge: { block: header, arguments: [next!] },
		});
		builder.setTerminator(exit, { kind: "return", value: counter });
		const finished = builder.finish(entry);
		const fn = program.function(finished.function);
		const cfg = buildCoreControlFlow(program, finished.function);
		expect(cfg.loops).toMatchObject([
			{ header, preheader: entry, depth: 1, canonical: true },
		]);
		const loops = analyzeCoreLoopInductions(fn, cfg, coreCanonicalValueRoots(fn, cfg));
		expect(loops.induction(counter)).toMatchObject({
			step: 1,
			range: { first: 0, last: 9, finalUpdate: 10 },
		});
		expect(loops.range(counter, latch)).toMatchObject({ minimum: 0, maximum: 9 });
		expect(loops.range(counter, header)).toMatchObject({ minimum: 0, maximum: 10 });
		expect(loops.range(counter)).toMatchObject({ minimum: 0, maximum: 10 });
		expect(loops.range(next!, latch)).toMatchObject({ minimum: 1, maximum: 10 });
	});

	it("bounds short arithmetic chains without certifying negative zero or unsafe results", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const block = builder.createBlock([{ representation: "boxed" }]);
		const unknown = inspectCoreBlockParameters(builder, block)[0]!.value;
		const literal = (value: number) =>
			builder.appendInstruction(block, "createF64", [], {
				attributes: { value },
				outputRepresentations: ["f64"],
			})[0]!;
		const binary = (operator: string, left: typeof unknown, right: typeof unknown) =>
			builder.appendInstruction(block, "binary", [left, right], {
				attributes: { operator },
				outputRepresentations: ["f64"],
			})[0]!;
		const mask = binary("&", unknown, literal(15));
		const product = binary("*", mask, literal(47));
		const remainder = binary("%", product, literal(800));
		const shifted = binary(">>>", unknown, literal(3));
		const negativeZero = binary("%", literal(-8), literal(4));
		const negative = binary("*", mask, literal(-1));
		const zeroDivisor = binary("%", mask, literal(0));
		const overflow = binary("+", literal(Number.MAX_SAFE_INTEGER), literal(1));
		const signedZero = binary("+", literal(-0), literal(-0));
		let longChain = unknown;
		longChain = binary("&", longChain, literal(15));
		for (let index = 0; index < 40; index++)
			longChain = binary("+", longChain, literal(1));
		builder.setTerminator(block, { kind: "return", value: remainder });
		const id = builder.finish(block).function;
		const fn = program.function(id);
		const cfg = buildCoreControlFlow(program, id);
		const ranges = analyzeCoreLoopInductions(fn, cfg, coreCanonicalValueRoots(fn, cfg));
		expect(ranges.hasNumericRanges).toBe(true);
		expect(ranges.range(mask, block)).toMatchObject({ minimum: 0, maximum: 15 });
		expect(ranges.range(product, block)).toMatchObject({ minimum: 0, maximum: 705 });
		expect(ranges.range(remainder, block)).toMatchObject({ minimum: 0, maximum: 705 });
		expect(ranges.range(shifted, block)).toMatchObject({
			minimum: 0,
			maximum: 0x1fff_ffff,
		});
		for (const value of [
			negativeZero,
			negative,
			zeroDivisor,
			overflow,
			signedZero,
			longChain,
		])
			expect(ranges.range(value, block)).toBeUndefined();
	});

	it("recognizes a unique preheader with duplicate edges from one latch", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([
			{ representation: "boolean" },
			{ representation: "boolean" },
			{ representation: "boxed" },
			{ representation: "boxed" },
		]);
		const [continueLoop, chooseBackedge, left, right] = inspectCoreBlockParameters(
			builder,
			entry,
		).map(({ value }) => value);
		const header = builder.createBlock([{ representation: "boxed" }]);
		const latch = builder.createBlock();
		const exit = builder.createBlock();
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: header, arguments: [left!] },
		});
		builder.setTerminator(header, {
			kind: "branch",
			condition: continueLoop!,
			consequent: { block: latch, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		builder.setTerminator(latch, {
			kind: "branch",
			condition: chooseBackedge!,
			consequent: { block: header, arguments: [left!] },
			alternate: { block: header, arguments: [right!] },
		});
		builder.setTerminator(exit, {
			kind: "return",
			value: inspectCoreBlockParameters(builder, header)[0]!.value,
		});
		const function_ = builder.finish(entry).function;
		const before = buildCoreControlFlow(program, function_);
		expect(before.loops).toHaveLength(1);
		expect(before.loops[0]).toMatchObject({
			header,
			preheader: entry,
			canonical: false,
		});

		const optimized = optimizeCore({ program, context }, { verification: "per-pass" })
			.compilation.program;
		const fn = optimized.function(function_);
		const after = buildCoreControlFlow(optimized, function_);
		expect(after.loops).toHaveLength(1);
		expect(after.loops[0]).toMatchObject({ canonical: true });
		expect(fn.blockCapacity).toBeLessThanOrEqual(5);
	});

	it("derives exact ranges only for safe additive block-argument inductions", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const build = (initial: number, representation: "f64" | "i32") => {
			const builder = new CoreFunctionBuilder(program);
			const entry = builder.createBlock();
			const header = builder.createBlock([{ representation }]);
			const body = builder.createBlock();
			const exit = builder.createBlock([{ representation }]);
			const [seed] = builder.appendInstruction(entry, "createF64", [], {
				attributes: { value: initial },
				outputRepresentations: [representation],
			});
			const [bound] = builder.appendInstruction(entry, "createF64", [], {
				attributes: { value: 10 },
				outputRepresentations: [representation],
			});
			builder.setTerminator(entry, {
				kind: "jump",
				edge: { block: header, arguments: [seed!] },
			});
			const counter = inspectCoreBlockParameters(builder, header)[0]!.value;
			const [condition] = builder.appendInstruction(header, "binary", [counter, bound!], {
				attributes: { operator: "<" },
				outputRepresentations: ["boolean"],
			});
			builder.setTerminator(header, {
				kind: "branch",
				condition: condition!,
				consequent: { block: body, arguments: [] },
				alternate: { block: exit, arguments: [counter] },
			});
			const [next] = builder.appendInstruction(body, "unary", [counter], {
				attributes: { operator: "increment" },
				outputRepresentations: [representation],
			});
			builder.setTerminator(body, {
				kind: "jump",
				edge: { block: header, arguments: [next!] },
			});
			builder.setTerminator(exit, {
				kind: "return",
				value: inspectCoreBlockParameters(builder, exit)[0]!.value,
			});
			return { function: builder.finish(entry).function, counter };
		};
		const negativeZero = build(-0, "f64");
		const negativeZeroFunction = program.function(negativeZero.function);
		const negativeZeroCfg = buildCoreControlFlow(program, negativeZero.function);
		expect(
			analyzeCoreLoopInductions(
				negativeZeroFunction,
				negativeZeroCfg,
				coreCanonicalValueRoots(negativeZeroFunction, negativeZeroCfg),
			).induction(negativeZero.counter)?.range,
		).toBeUndefined();
		const int32 = build(0, "i32");
		const int32Function = program.function(int32.function);
		const int32Cfg = buildCoreControlFlow(program, int32.function);
		expect(
			analyzeCoreLoopInductions(
				int32Function,
				int32Cfg,
				coreCanonicalValueRoots(int32Function, int32Cfg),
			).induction(int32.counter),
		).toMatchObject({
			representation: "i32",
			range: { minimum: 0, maximum: 9, finalUpdate: 10 },
		});
	});

	it("applies only representation-proven numeric identities", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const build = (
			operator: string,
			constantValue: number | undefined,
			options: { readonly self?: boolean; readonly constantLeft?: boolean } = {},
		) => {
			const builder = new CoreFunctionBuilder(program);
			const entry = builder.createBlock([{ representation: "boolean" }]);
			const left = builder.createBlock();
			const right = builder.createBlock();
			const join = builder.createBlock([{ representation: "f64" }]);
			const condition = inspectCoreBlockParameters(builder, entry)[0]!.value;
			builder.setTerminator(entry, {
				kind: "branch",
				condition,
				consequent: { block: left, arguments: [] },
				alternate: { block: right, arguments: [] },
			});
			const [leftValue] = builder.appendInstruction(left, "createF64", [], {
				attributes: { value: -2 },
				outputRepresentations: ["f64"],
			});
			const [rightValue] = builder.appendInstruction(right, "createF64", [], {
				attributes: { value: 3 },
				outputRepresentations: ["f64"],
			});
			builder.setTerminator(left, {
				kind: "jump",
				edge: { block: join, arguments: [leftValue!] },
			});
			builder.setTerminator(right, {
				kind: "jump",
				edge: { block: join, arguments: [rightValue!] },
			});
			const dynamic = inspectCoreBlockParameters(builder, join)[0]!.value;
			const constant =
				constantValue === undefined
					? dynamic
					: builder.appendInstruction(join, "createF64", [], {
							attributes: { value: constantValue },
							outputRepresentations: ["f64"],
						})[0]!;
			const comparison = ["<", "<=", ">", ">="].includes(operator);
			const inputs = options.self
				? [dynamic, dynamic]
				: options.constantLeft
					? [constant, dynamic]
					: [dynamic, constant];
			const [result] = builder.appendInstruction(join, "binary", inputs, {
				attributes: { operator },
				outputRepresentations: [comparison ? "boolean" : "f64"],
			});
			builder.setTerminator(join, { kind: "return", value: result! });
			return builder.finish(entry).function;
		};
		const functions = [
			build("+", -0),
			build("+", 0),
			build("*", 1),
			build("&", 0),
			build("<", undefined, { self: true }),
			build("<", 5, { constantLeft: true }),
		];
		const optimized = optimizeCore({ program, context }, { verification: "per-pass" })
			.compilation.program;
		const binaries = (index: number) => {
			const fn = optimized.function(functions[index]!);
			return [...fn.instructionIds()].filter(
				(instruction) =>
					fn.instructionKind(instruction) === "operation" &&
					fn.instructionOpcodeName(instruction) === "binary",
			);
		};
		expect(binaries(0)).toHaveLength(0);
		expect(binaries(1)).toHaveLength(1);
		expect(binaries(2)).toHaveLength(0);
		expect(binaries(3)).toHaveLength(0);
		expect(binaries(4)).toHaveLength(0);
		expect(binaries(5)).toHaveLength(1);
		expect(
			optimized.function(functions[5]!).instructionAttributes(binaries(5)[0]!).operator,
		).toBe(">");
	});

	it("reselects an exact numeric join after algebraic simplification", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{ representation: "boolean" }]);
		const left = builder.createBlock();
		const right = builder.createBlock();
		const join = builder.createBlock();
		const condition = inspectCoreBlockParameters(builder, entry)[0]!.value;
		builder.setTerminator(entry, {
			kind: "branch",
			condition,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		const [leftValue] = builder.appendInstruction(left, "createF64", [], {
			attributes: { value: -2 },
			outputRepresentations: ["f64"],
		});
		const [rightValue] = builder.appendInstruction(right, "createF64", [], {
			attributes: { value: 3 },
			outputRepresentations: ["f64"],
		});
		const [leftBoxed] = builder.appendInstruction(left, "move", [leftValue!], {
			outputRepresentations: ["boxed"],
		});
		const [rightBoxed] = builder.appendInstruction(right, "move", [rightValue!], {
			outputRepresentations: ["boxed"],
		});
		const joined = builder.appendBlockParameter(join);
		builder.setTerminator(left, {
			kind: "jump",
			edge: { block: join, arguments: [leftBoxed!] },
		});
		builder.setTerminator(right, {
			kind: "jump",
			edge: { block: join, arguments: [rightBoxed!] },
		});
		const [negativeZero] = builder.appendInstruction(join, "createF64", [], {
			attributes: { value: -0 },
			outputRepresentations: ["f64"],
		});
		const [sum] = builder.appendInstruction(join, "binary", [joined, negativeZero!], {
			attributes: { operator: "+" },
		});
		builder.setTerminator(join, { kind: "return", value: sum! });
		const function_ = builder.finish(entry).function;
		const fn = optimizeCore(
			{ program, context },
			{ verification: "per-pass" },
		).compilation.program.function(function_);
		expect(fn.valueRepresentation(joined)).toBe("i32");
		expect(
			[...fn.instructionIds()].some(
				(instruction) =>
					fn.instructionKind(instruction) === "operation" &&
					fn.instructionOpcodeName(instruction) === "binary" &&
					fn.instructionAttributes(instruction).operator === "+",
			),
		).toBe(false);
	});

	it("scalarizes signed bitwise results used only at property and call boundaries", () => {
		const program = optimizeSource(`
			function maskedCalls(values, callback, index) {
				const numeric = +index;
				return callback(values[numeric & 31], numeric & 255);
			}
		`);
		const fn = coreFunctionNamed(program, "maskedCalls");
		if (fn === undefined) throw new Error("missing maskedCalls");
		const masks = coreOperations(fn).filter(
			({ opcode, attributes }) => opcode === "binary" && attributes.operator === "&",
		);
		expect(masks).toHaveLength(2);
		for (const mask of masks) {
			expect(fn.valueRepresentation(mask.outputs[0]!)).toBe("i32");
			expect(fn.valueRepresentation(mask.inputs[0]!)).toBe("boxed");
		}
	});

	it("hoists pure loop invariants while retaining observable identity creation", () => {
		const context = lockedMathContext;
		const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 1 });
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{ representation: "boolean" }]);
		const header = builder.createBlock();
		const body = builder.createBlock();
		const exit = builder.createBlock();
		const condition = inspectCoreBlockParameters(builder, entry)[0]!.value;
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: header, arguments: [] },
		});
		builder.setTerminator(header, {
			kind: "branch",
			condition,
			consequent: { block: body, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		const [constant] = builder.appendInstruction(body, "createF64", [], {
			attributes: { value: 0.5 },
			outputRepresentations: ["f64"],
		});
		const [sine] = builder.appendInstruction(body, "mathUnaryNumber", [constant!], {
			attributes: {
				operation: "Math.sin",
				worldAssumptions: {
					...builtinWorldAssumptions("Math.sin", "exact-builtin-proof"),
				},
			},
			outputRepresentations: ["f64"],
		});
		builder.appendInstruction(body, "storeGlobal", [sine!], {
			attributes: { index: 0 },
		});
		const [object] = builder.appendInstruction(body, "createObject", []);
		builder.appendInstruction(body, "storeGlobal", [object!], {
			attributes: { index: 0 },
		});
		builder.setTerminator(body, {
			kind: "jump",
			edge: { block: header, arguments: [] },
		});
		builder.setTerminator(exit, { kind: "return", value: condition });
		const function_ = builder.finish(entry).function;
		const fn = optimizeCore(
			{ program, context },
			{ verification: "per-pass" },
		).compilation.program.function(function_);
		const finalConstant = [...fn.instructionIds()].find(
			(instruction) =>
				fn.instructionKind(instruction) === "operation" &&
				fn.instructionOpcodeName(instruction) === "createF64" &&
				fn.instructionAttributes(instruction).value === 0.5,
		)!;
		const finalSine = [...fn.instructionIds()].find(
			(instruction) =>
				fn.instructionKind(instruction) === "operation" &&
				fn.instructionOpcodeName(instruction) === "mathUnaryNumber",
		)!;
		const finalObject = [...fn.instructionIds()].find(
			(instruction) =>
				fn.instructionKind(instruction) === "operation" &&
				fn.instructionOpcodeName(instruction) === "createObject",
		)!;
		expect(fn.instructionBlock(finalConstant)).toBe(fn.entry);
		expect(fn.instructionBlock(finalSine)).toBe(fn.entry);
		expect(fn.instructionBlock(finalObject)).not.toBe(fn.entry);
	});

	it("batches independent loop invariants in one pass item", () => {
		const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 2 });
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{ representation: "boolean" }]);
		const header = builder.createBlock();
		const body = builder.createBlock();
		const exit = builder.createBlock();
		const condition = inspectCoreBlockParameters(builder, entry)[0]!.value;
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: header, arguments: [] },
		});
		builder.setTerminator(header, {
			kind: "branch",
			condition,
			consequent: { block: body, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		const [left] = builder.appendInstruction(body, "createF64", [], {
			attributes: { value: 0.5 },
			outputRepresentations: ["f64"],
		});
		const [right] = builder.appendInstruction(body, "createF64", [], {
			attributes: { value: 1.5 },
			outputRepresentations: ["f64"],
		});
		builder.appendInstruction(body, "storeGlobal", [left!], {
			attributes: { index: 0 },
		});
		builder.appendInstruction(body, "storeGlobal", [right!], {
			attributes: { index: 1 },
		});
		builder.setTerminator(body, {
			kind: "jump",
			edge: { block: header, arguments: [] },
		});
		builder.setTerminator(exit, { kind: "return", value: condition });
		builder.finish(entry);

		const optimized = optimizeCore(
			{ program, context },
			{ verification: "per-pass", instrumentation: "full" },
		);
		expect(
			optimized.report.passes.find(({ pass }) => pass === "loop-invariant-code-motion"),
		).toMatchObject({ changedItems: 1, edits: 2 });
	});

	it("canonicalizes multiple latches and shared exits", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([
			{ representation: "boolean" },
			{ representation: "boolean" },
			{ representation: "boolean" },
		]);
		const [path, iterate, latchCondition] = inspectCoreBlockParameters(
			builder,
			entry,
		).map(({ value }) => value);
		const bypass = builder.createBlock();
		const header = builder.createBlock();
		const body = builder.createBlock();
		const leftLatch = builder.createBlock();
		const rightLatch = builder.createBlock();
		const exit = builder.createBlock();
		builder.setTerminator(entry, {
			kind: "branch",
			condition: path!,
			consequent: { block: header, arguments: [] },
			alternate: { block: bypass, arguments: [] },
		});
		builder.setTerminator(bypass, {
			kind: "jump",
			edge: { block: exit, arguments: [] },
		});
		builder.setTerminator(header, {
			kind: "branch",
			condition: iterate!,
			consequent: { block: body, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		builder.setTerminator(body, {
			kind: "branch",
			condition: latchCondition!,
			consequent: { block: leftLatch, arguments: [] },
			alternate: { block: rightLatch, arguments: [] },
		});
		for (const latch of [leftLatch, rightLatch]) {
			builder.setTerminator(latch, {
				kind: "jump",
				edge: { block: header, arguments: [] },
			});
		}
		builder.setTerminator(exit, { kind: "return", value: path! });
		const function_ = builder.finish(entry).function;
		const optimized = optimizeCore({ program, context }, { verification: "per-pass" })
			.compilation.program;
		const cfg = buildCoreControlFlow(optimized, function_);
		expect(cfg.loops).toHaveLength(1);
		expect(cfg.loops[0]).toMatchObject({ canonical: true });
		expect(cfg.loops[0]!.preheader).toBeDefined();
		expect(cfg.loops[0]!.latches.size).toBe(1);
		expect(cfg.loops[0]!.exits.every(({ dedicated }) => dedicated)).toBe(true);
	});

	it("hoists only exact load partitions unchanged by the loop", () => {
		const context = lockedMathContext;
		const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 2 });
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{ representation: "boolean" }]);
		const header = builder.createBlock();
		const body = builder.createBlock();
		const exit = builder.createBlock();
		const condition = inspectCoreBlockParameters(builder, entry)[0]!.value;
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: header, arguments: [] },
		});
		const [changing] = builder.appendInstruction(header, "loadGlobal", [], {
			attributes: { index: 0 },
			outputRepresentations: ["f64"],
		});
		const [stable] = builder.appendInstruction(header, "loadGlobal", [], {
			attributes: { index: 1 },
			outputRepresentations: ["f64"],
		});
		const [result] = builder.appendInstruction(
			header,
			"mathBinaryNumber",
			[changing!, stable!],
			{
				attributes: {
					operation: "Math.max",
					worldAssumptions: {
						...builtinWorldAssumptions("Math.max", "exact-builtin-proof"),
					},
				},
				outputRepresentations: ["f64"],
			},
		);
		builder.setTerminator(header, {
			kind: "branch",
			condition,
			consequent: { block: body, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		builder.appendInstruction(body, "storeGlobal", [changing!], {
			attributes: { index: 0 },
		});
		builder.setTerminator(body, {
			kind: "jump",
			edge: { block: header, arguments: [] },
		});
		builder.setTerminator(exit, { kind: "return", value: result! });
		const function_ = builder.finish(entry).function;
		const fn = optimizeCore(
			{ program, context },
			{ verification: "per-pass" },
		).compilation.program.function(function_);
		const loads = [...fn.instructionIds()].filter(
			(instruction) =>
				fn.instructionKind(instruction) === "operation" &&
				fn.instructionOpcodeName(instruction) === "loadGlobal",
		);
		const changingLoad = loads.find(
			(instruction) => fn.instructionAttributes(instruction).index === 0,
		)!;
		const stableLoad = loads.find(
			(instruction) => fn.instructionAttributes(instruction).index === 1,
		)!;
		const cfg = buildCoreControlFlow(program, function_);
		expect(fn.instructionBlock(changingLoad)).toBe(cfg.loops[0]!.header);
		expect(fn.instructionBlock(stableLoad)).toBe(fn.entry);
	});

	it("does not hoist memory reads across calls into unknown user code", () => {
		const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 1 });
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([
			{ representation: "boolean" },
			{ representation: "boxed" },
		]);
		const [condition, callee] = inspectCoreBlockParameters(builder, entry).map(
			({ value }) => value,
		);
		const header = builder.createBlock();
		const body = builder.createBlock();
		const exit = builder.createBlock();
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: header, arguments: [] },
		});
		const [loaded] = builder.appendInstruction(header, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		builder.setTerminator(header, {
			kind: "branch",
			condition: condition!,
			consequent: { block: body, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		builder.appendInstruction(body, "call", [callee!, callee!]);
		builder.setTerminator(body, {
			kind: "jump",
			edge: { block: header, arguments: [] },
		});
		builder.setTerminator(exit, { kind: "return", value: loaded! });
		const function_ = builder.finish(entry).function;
		const fn = optimizeCore(
			{ program, context },
			{ verification: "per-pass" },
		).compilation.program.function(function_);
		expect(fn.instructionBlock(definingInstruction(fn, loaded!))).toBe(header);
	});

	it("hoists the stable length of a contained array", () => {
		const program = new CoreProgram(coreOpcodeRegistry, {
			globalCount: 1,
			stringConstants: [[..."length"].map((unit) => unit.codePointAt(0)!)],
		});
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{ representation: "boolean" }]);
		const header = builder.createBlock();
		const body = builder.createBlock();
		const exit = builder.createBlock();
		const condition = inspectCoreBlockParameters(builder, entry)[0]!.value;
		const [array] = builder.appendInstruction(entry, "createArray", [], {
			attributes: { length: 3 },
		});
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: header, arguments: [] },
		});
		const [length] = builder.appendInstruction(header, "loadPropertyStatic", [array!], {
			attributes: { stringIndex: 0 },
		});
		builder.setTerminator(header, {
			kind: "branch",
			condition,
			consequent: { block: body, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		builder.appendInstruction(body, "storeGlobal", [length!], {
			attributes: { index: 0 },
		});
		builder.setTerminator(body, {
			kind: "jump",
			edge: { block: header, arguments: [] },
		});
		builder.setTerminator(exit, { kind: "return", value: length! });
		const function_ = builder.finish(entry).function;
		const optimized = optimizeCore({ program, context }, { verification: "per-pass" })
			.compilation.program;
		const fn = optimized.function(function_);
		expect(fn.instructionBlock(definingInstruction(fn, length!))).toBe(entry);
		const loop = buildCoreControlFlow(optimized, function_).loops[0];
		expect(loop).toBeDefined();
		expect(loop!.blocks.has(entry)).toBe(false);
	});

	it("hoists the stable length of a private exact Array.from result", () => {
		const program = optimizeSource(`
			function denseFactoryTraversal(scale) {
				const values = Array.from({ length: 64 }, (_, index) => ({ value: index }));
				let checksum = 0;
				for (let round = 0; round < scale; round++) {
					for (let index = 0; index < values.length; index++) checksum += values[index].value;
				}
				return checksum;
			}
			globalThis.result = denseFactoryTraversal(2);
		`);
		const { fn, load } = sourceLengthLoad(program, "denseFactoryTraversal");
		const cfg = buildCoreControlFlow(program, fn.id);
		expect(cfg.loops.every((loop) => !loop.blocks.has(load.block))).toBe(true);
	});

	it("hoists the stable length of a private array through a same-root alias", () => {
		const program = optimizeSource(`
			function arrayTraversal(flag) {
				const values = Array.from({ length: 64 }, (_, index) => index);
				const alias = flag ? values : values;
				let checksum = 0;
				for (let index = 0; index < alias.length; index++) checksum += +alias[index];
				return checksum;
			}
			globalThis.result = arrayTraversal(globalThis.flag);
		`);
		const { fn, load } = sourceLengthLoad(program, "arrayTraversal");
		const cfg = buildCoreControlFlow(program, fn.id);
		expect(cfg.loops.every((loop) => !loop.blocks.has(load.block))).toBe(true);
	});

	it("retains a private array length load when a mixed-root alias can shrink it", () => {
		const program = optimizeSource(`
			function shorten(flag) {
				const values = [];
				values[0] = 10;
				values[1] = 20;
				values[2] = 30;
				const alias = flag ? values : [];
				let checksum = 0;
				for (let index = 0; index < values.length; index++) {
					checksum += +values[index];
					if (index === 0) alias.length = 1;
				}
				return checksum;
			}
			globalThis.result = shorten(globalThis.flag);
		`);
		const { fn, load } = sourceLengthLoad(program, "shorten");
		const loop = buildCoreControlFlow(program, fn.id).loops[0];
		expect(loop).toBeDefined();
		expect(loop!.blocks.has(load.block)).toBe(true);
	});

	it("retains a private array length load after exceptional mixed-root aliasing", () => {
		const program = optimizeSource(`
			function shortenAcrossHandler() {
				const values = Array.from({ length: 64 }, (_, index) => index);
				let alias = [];
				try {
					globalThis.beforeAlias();
					alias = values;
					globalThis.afterAlias();
				} catch {
					alias.length = 1;
				}
				let checksum = 0;
				for (let index = 0; index < values.length; index++) checksum += +values[index];
				return checksum;
			}
			globalThis.result = shortenAcrossHandler();
		`);
		const { fn, load } = sourceLengthLoad(program, "shortenAcrossHandler");
		const loop = buildCoreControlFlow(program, fn.id).loops[0];
		expect(loop).toBeDefined();
		expect(loop!.blocks.has(load.block)).toBe(true);
	});

	it("rejects a canonical Array.from callee with the wrong call receiver", () => {
		const program = new CoreProgram(coreOpcodeRegistry, {
			stringConstants: [[..."from"].map((unit) => unit.codePointAt(0)!)],
		});
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const [array] = builder.appendInstruction(entry, "loadIntrinsic", [], {
			attributes: { intrinsic: "Array" },
		});
		const [from] = builder.appendInstruction(entry, "createString", [], {
			attributes: { stringIndex: 0 },
		});
		const [callee] = builder.appendInstruction(entry, "loadProperty", [array!, from!]);
		const [object] = builder.appendInstruction(entry, "loadIntrinsic", [], {
			attributes: { intrinsic: "Object" },
		});
		const [result] = builder.appendInstruction(entry, "call", [callee!, object!]);
		builder.setTerminator(entry, { kind: "return", value: result! });
		const functionId = builder.finish(entry).function;
		const fn = program.function(functionId);
		expect(
			coreExactArrayFromCallResult(
				program,
				fn,
				coreCanonicalValueRoots(fn, buildCoreControlFlow(program, functionId)),
				lockedArrayContext,
				definingInstruction(fn, result!),
			),
		).toBeUndefined();
	});

	it.each([
		{
			name: "escapes",
			before: "globalThis.values = values;",
			body: "checksum += values[index];",
		},
		{
			name: "grows during traversal",
			before: "",
			body: "values[index + 64] = index; checksum += values[index];",
		},
	])("retains an Array.from length load when the result $name", ({ before, body }) => {
		const program = optimizeSource(`
			function factoryTraversal(scale) {
				const values = Array.from({ length: 64 }, (_, index) => index);
				${before}
				let checksum = 0;
				for (let round = 0; round < scale; round++) {
					for (let index = 0; index < values.length; index++) { ${body} }
				}
				return checksum;
			}
			globalThis.result = factoryTraversal(2);
		`);
		const { fn, load } = sourceLengthLoad(program, "factoryTraversal");
		const inner = buildCoreControlFlow(program, fn.id).loops.reduce((deepest, loop) =>
			loop.depth > deepest.depth ? loop : deepest,
		);
		expect(inner.blocks.has(load.block)).toBe(true);
	});

	it("retains an Array.from length load without locked primordial facts", () => {
		const program = optimizeSource(
			`function factoryTraversal(scale) {
				const values = Array.from({ length: 64 }, (_, index) => index);
				let checksum = 0;
				for (let index = 0; index < values.length * scale; index++) checksum += values[index & 63];
				return checksum;
			}
			globalThis.result = factoryTraversal(2);`,
			context,
		);
		const { fn, load } = sourceLengthLoad(program, "factoryTraversal");
		const loop = buildCoreControlFlow(program, fn.id).loops[0];
		expect(loop).toBeDefined();
		expect(loop!.blocks.has(load.block)).toBe(true);
	});

	it("retains a private array length load when the loop can grow it", () => {
		const program = new CoreProgram(coreOpcodeRegistry, {
			stringConstants: [[..."length"].map((unit) => unit.codePointAt(0)!)],
		});
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{ representation: "boolean" }]);
		const header = builder.createBlock();
		const body = builder.createBlock();
		const exit = builder.createBlock();
		const condition = inspectCoreBlockParameters(builder, entry)[0]!.value;
		const [array] = builder.appendInstruction(entry, "createArray", [], {
			attributes: { length: 0 },
		});
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: header, arguments: [] },
		});
		const [length] = builder.appendInstruction(header, "loadPropertyStatic", [array!], {
			attributes: { stringIndex: 0 },
		});
		builder.setTerminator(header, {
			kind: "branch",
			condition,
			consequent: { block: body, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		const [key] = builder.appendInstruction(body, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [value] = builder.appendInstruction(body, "createNumber", [], {
			attributes: { value: 1 },
		});
		builder.appendInstruction(body, "storeProperty", [array!, key!, value!]);
		builder.setTerminator(body, {
			kind: "jump",
			edge: { block: header, arguments: [] },
		});
		builder.setTerminator(exit, { kind: "return", value: length! });
		const function_ = builder.finish(entry).function;
		const optimized = optimizeCore(
			{ program, context: lockedArrayContext },
			{ verification: "per-pass" },
		).compilation.program;
		const fn = optimized.function(function_);
		const load = [...fn.instructionIds()].find(
			(instruction) =>
				fn.instructionKind(instruction) === "operation" &&
				fn.instructionOpcodeName(instruction) === "loadPropertyStatic",
		)!;
		expect(fn.instructionBlock(load)).toBe(
			buildCoreControlFlow(optimized, function_).loops[0]!.header,
		);
	});

	it("eliminates partial redundancy on non-speculative merge edges", () => {
		const registry = new CoreOpcodeRegistry();
		registry.define({
			opcode: "purePair",
			inputs: coreArity(2),
			outputs: coreArity(1),
			effects: CORE_NO_EFFECTS,
			discardable: true,
			attributeRelocations: [],
		});
		registry.define({
			opcode: "keep",
			inputs: coreArity(1),
			outputs: coreArity(0),
			effects: CORE_NO_EFFECTS,
			discardable: false,
			attributeRelocations: [],
		});
		const program = new CoreProgram(registry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([
			{ representation: "boxed" },
			{ representation: "boxed" },
			{ representation: "boolean" },
			{ representation: "boolean" },
		]);
		const left = builder.createBlock();
		const right = builder.createBlock();
		const merge = builder.createBlock();
		const fallback = builder.createBlock();
		const [first, second, condition, guardCondition] = inspectCoreBlockParameters(
			builder,
			entry,
		).map(({ value }) => value);
		builder.setTerminator(entry, {
			kind: "branch",
			condition: condition!,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		const [available] = builder.appendInstruction(left, "purePair", [first!, second!]);
		builder.appendInstruction(left, "keep", [available!]);
		builder.setGuardTerminator(left, {
			condition: guardCondition!,
			success: { block: merge, arguments: [] },
			fallback: { block: fallback, arguments: [] },
			fact: {
				kind: "test-identity",
				value: true,
				claims: [{ kind: "identity", subject: guardCondition!, identities: [true] }],
				origin: "control-flow-passes-test",
			},
		});
		builder.appendInstruction(right, "keep", [first!]);
		builder.setTerminator(right, { kind: "jump", edge: { block: merge, arguments: [] } });
		builder.setTerminator(fallback, { kind: "return", value: first! });
		const [redundant] = builder.appendInstruction(merge, "purePair", [first!, second!]);
		builder.setTerminator(merge, { kind: "return", value: redundant! });
		const finished = builder.finish(entry);
		const optimized = optimizeCore(
			{ program, context },
			{ mode: "full", verification: "per-pass", instrumentation: "full" },
		);
		const fn = optimized.compilation.program.function(finished.function);
		expect(inspectCoreBlockParameters(fn, merge)).toHaveLength(1);
		expect([...fn.bodyInstructionIds(merge)]).toEqual([]);
		expect(
			optimized.report.passes.find(
				({ pass }) => pass === "partial-redundancy-elimination",
			),
		).toMatchObject({ changedItems: 1 });
	});

	it("removes a merge expression already available on every incoming path", () => {
		const context = lockedMathContext;
		const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 1 });
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{ representation: "boolean" }]);
		const left = builder.createBlock();
		const right = builder.createBlock();
		const merge = builder.createBlock();
		const condition = inspectCoreBlockParameters(builder, entry)[0]!.value;
		const [operand] = builder.appendInstruction(entry, "createF64", [], {
			attributes: { value: 0.5 },
			outputRepresentations: ["f64"],
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		for (const branch of [left, right]) {
			const [available] = builder.appendInstruction(
				branch,
				"mathUnaryNumber",
				[operand!],
				{
					attributes: {
						operation: "Math.sin",
						worldAssumptions: {
							...builtinWorldAssumptions("Math.sin", "exact-builtin-proof"),
						},
					},
					outputRepresentations: ["f64"],
				},
			);
			builder.appendInstruction(branch, "storeGlobal", [available!], {
				attributes: { index: 0 },
			});
			builder.setTerminator(branch, {
				kind: "jump",
				edge: { block: merge, arguments: [] },
			});
		}
		const [redundant] = builder.appendInstruction(merge, "mathUnaryNumber", [operand!], {
			attributes: {
				operation: "Math.sin",
				worldAssumptions: {
					...builtinWorldAssumptions("Math.sin", "exact-builtin-proof"),
				},
			},
			outputRepresentations: ["f64"],
		});
		builder.setTerminator(merge, { kind: "return", value: redundant! });
		const function_ = builder.finish(entry).function;
		const fn = optimizeCore(
			{ program, context },
			{ verification: "per-pass" },
		).compilation.program.function(function_);
		expect(
			[...fn.instructionIds()].filter(
				(instruction) =>
					fn.instructionKind(instruction) === "operation" &&
					fn.instructionOpcodeName(instruction) === "mathUnaryNumber",
			),
		).toHaveLength(2);
	});

	it("does not resurrect a dead predecessor expression for PRE", () => {
		const context = lockedMathContext;
		const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 1 });
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{ representation: "boolean" }]);
		const left = builder.createBlock();
		const right = builder.createBlock();
		const merge = builder.createBlock();
		const condition = inspectCoreBlockParameters(builder, entry)[0]!.value;
		const [operand] = builder.appendInstruction(entry, "createF64", [], {
			attributes: { value: 0.5 },
			outputRepresentations: ["f64"],
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		builder.appendInstruction(left, "mathUnaryNumber", [operand!], {
			attributes: {
				operation: "Math.sin",
				worldAssumptions: {
					...builtinWorldAssumptions("Math.sin", "exact-builtin-proof"),
				},
			},
			outputRepresentations: ["f64"],
		});
		builder.setTerminator(left, {
			kind: "jump",
			edge: { block: merge, arguments: [] },
		});
		builder.appendInstruction(right, "storeGlobal", [condition], {
			attributes: { index: 0 },
		});
		builder.setTerminator(right, {
			kind: "jump",
			edge: { block: merge, arguments: [] },
		});
		const [result] = builder.appendInstruction(merge, "mathUnaryNumber", [operand!], {
			attributes: {
				operation: "Math.sin",
				worldAssumptions: {
					...builtinWorldAssumptions("Math.sin", "exact-builtin-proof"),
				},
			},
			outputRepresentations: ["f64"],
		});
		builder.setTerminator(merge, { kind: "return", value: result! });
		const function_ = builder.finish(entry).function;
		const fn = optimizeCore(
			{ program, context },
			{ verification: "per-pass" },
		).compilation.program.function(function_);
		expect(
			[...fn.instructionIds()].filter(
				(instruction) =>
					fn.instructionKind(instruction) === "operation" &&
					fn.instructionOpcodeName(instruction) === "mathUnaryNumber",
			),
		).toHaveLength(1);
	});

	it("numbers pure values through the dominator tree", () => {
		const context = lockedMathContext;
		const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 1 });
		const builder = new CoreFunctionBuilder(program, { parameterCount: 2 });
		const entry = builder.createBlock([
			{ representation: "boxed" },
			{ representation: "boxed" },
		]);
		const [input, condition] = inspectCoreBlockParameters(builder, entry).map(
			({ value }) => value,
		);
		const body = builder.createBlock();
		const exit = builder.createBlock();
		const [numeric] = builder.appendInstruction(entry, "move", [input!], {
			outputRepresentations: ["f64"],
		});
		const [dominating] = builder.appendInstruction(entry, "mathUnaryNumber", [numeric!], {
			attributes: {
				operation: "Math.sin",
				worldAssumptions: {
					...builtinWorldAssumptions("Math.sin", "exact-builtin-proof"),
				},
			},
			outputRepresentations: ["f64"],
		});
		builder.appendInstruction(entry, "storeGlobal", [dominating!], {
			attributes: { index: 0 },
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition: condition!,
			consequent: { block: body, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		const [redundant] = builder.appendInstruction(body, "mathUnaryNumber", [numeric!], {
			attributes: {
				operation: "Math.sin",
				worldAssumptions: {
					...builtinWorldAssumptions("Math.sin", "exact-builtin-proof"),
				},
			},
			outputRepresentations: ["f64"],
		});
		builder.setTerminator(body, { kind: "return", value: redundant! });
		builder.setTerminator(exit, { kind: "return", value: dominating! });
		const function_ = builder.finish(entry).function;

		const fn = optimizeCore(
			{ program, context },
			{ verification: "per-pass" },
		).compilation.program.function(function_);
		const numbered = [...fn.instructionIds()].filter(
			(instruction) =>
				fn.instructionKind(instruction) === "operation" &&
				fn.instructionOpcodeName(instruction) === "mathUnaryNumber",
		);
		expect(numbered).toHaveLength(1);
		const result = inspectCoreInstructionResults(fn, numbered[0]!)[0];
		expect(result).toBeDefined();
		for (const block of fn.blockIds()) {
			const terminator = inspectCoreTerminatorPayload(fn, fn.blockTerminator(block));
			if (terminator.kind === "return") expect(terminator.value).toBe(result);
		}
	});

	it("hoists invariants after canonicalizing multiple latches", () => {
		const context = lockedMathContext;
		const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 1 });
		const builder = new CoreFunctionBuilder(program, { parameterCount: 2 });
		const entry = builder.createBlock([
			{ representation: "boxed" },
			{ representation: "boxed" },
		]);
		const [continueLoop, chooseLatch] = inspectCoreBlockParameters(builder, entry).map(
			({ value }) => value,
		);
		const header = builder.createBlock();
		const body = builder.createBlock();
		const leftLatch = builder.createBlock();
		const rightLatch = builder.createBlock();
		const exit = builder.createBlock();
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: header, arguments: [] },
		});
		builder.setTerminator(header, {
			kind: "branch",
			condition: continueLoop!,
			consequent: { block: body, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		const [constant] = builder.appendInstruction(body, "createF64", [], {
			attributes: { value: 0.5 },
			outputRepresentations: ["f64"],
		});
		const [sine] = builder.appendInstruction(body, "mathUnaryNumber", [constant!], {
			attributes: {
				operation: "Math.sin",
				worldAssumptions: {
					...builtinWorldAssumptions("Math.sin", "exact-builtin-proof"),
				},
			},
			outputRepresentations: ["f64"],
		});
		builder.appendInstruction(body, "storeGlobal", [sine!], {
			attributes: { index: 0 },
		});
		builder.setTerminator(body, {
			kind: "branch",
			condition: chooseLatch!,
			consequent: { block: leftLatch, arguments: [] },
			alternate: { block: rightLatch, arguments: [] },
		});
		for (const latch of [leftLatch, rightLatch]) {
			builder.setTerminator(latch, {
				kind: "jump",
				edge: { block: header, arguments: [] },
			});
		}
		builder.setTerminator(exit, { kind: "return", value: continueLoop! });
		const function_ = builder.finish(entry).function;
		const before = buildCoreControlFlow(program, function_);
		expect(before.loops[0]!.latches).toEqual(new Set([leftLatch, rightLatch]));

		const optimized = optimizeCore({ program, context }, { verification: "per-pass" })
			.compilation.program;
		const fn = optimized.function(function_);
		const cfg = buildCoreControlFlow(optimized, function_);
		expect(cfg.loops).toHaveLength(1);
		expect(cfg.loops[0]).toMatchObject({ canonical: true });
		expect(cfg.loops[0]!.latches.size).toBe(1);
		expect(cfg.loops[0]!.preheader).toBeDefined();
		const hoisted = [...fn.instructionIds()].filter(
			(instruction) =>
				fn.instructionKind(instruction) === "operation" &&
				["createF64", "mathUnaryNumber"].includes(fn.instructionOpcodeName(instruction)),
		);
		expect(hoisted).toHaveLength(2);
		for (const instruction of hoisted) {
			expect(fn.instructionBlock(instruction)).toBe(cfg.loops[0]!.preheader);
		}
	});

	it("reuses the real CFG analysis across operand-only rewrites", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const parameter = inspectCoreBlockParameters(builder, entry)[0]!.value;
		const [copy] = builder.appendInstruction(entry, "move", [parameter]);
		const target = builder.createBlock([{ representation: "boxed" }]);
		const exit = builder.createBlock();
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: target, arguments: [copy!] },
		});
		builder.setTerminator(target, {
			kind: "jump",
			edge: { block: exit, arguments: [] },
		});
		builder.setTerminator(exit, {
			kind: "return",
			value: inspectCoreBlockParameters(builder, target)[0]!.value,
		});
		const finished = builder.finish(entry);
		const report = new CoreOptimizationReportBuilder(program);
		const analyses = new CoreAnalysisManager(program, context, report);
		const bundle = analyses.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, {
			scope: "function",
			function: finished.function,
		});
		const ordinary = bundle.ordinary();
		const first = bundle.exceptional();
		expect(first).toBe(ordinary);
		expect(first.successors[entry]![0]!.arguments).toEqual([copy!]);
		expect(first.successors[target]![0]!.arguments).toEqual([]);
		expect(
			analyses
				.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, {
					scope: "function",
					function: finished.function,
				})
				.exceptional(),
		).toBe(first);
		const definition = inspectCoreValueDefinition(
			program.function(finished.function),
			copy!,
		);
		if (definition.kind !== "instruction") throw new Error("Expected move result");
		const editor = CoreEditor.open(program, finished.function);
		editor.replaceValueUses(copy!, parameter);
		editor.removeInstruction(definition.instruction);
		const changes = editor.commit();
		expect(changes.domains).not.toContain("cfg");
		const second = analyses
			.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, {
				scope: "function",
				function: finished.function,
			})
			.exceptional();
		expect(second).toBe(first);
		expect(second.successors[entry]![0]!.arguments).toEqual([parameter]);
		expect(second.predecessors[target]![0]!.arguments).toEqual([parameter]);
		expect(second.successors[target]![0]!.arguments).toEqual([]);
		expect(second.predecessors[exit]![0]!.arguments).toEqual([]);
		const result = report.finish(program, { directEntries: [], specializations: [] });
		expect(result.analyses).toMatchObject([
			{ analysis: "control-flow-bundle", queries: 3, hits: 2, recomputations: 1 },
		]);
	});
});
