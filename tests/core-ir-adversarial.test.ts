import { describe, expect, it } from "vitest";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import {
	buildCoreControlFlow,
	coreTerminatorEdges,
} from "../src/compiler/core/core-ir-control-flow.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { verifyCoreProgram } from "../src/compiler/core/core-ir-verifier.ts";
import type {
	CoreBlockId,
	CoreFunctionId,
	CoreInstructionEffects,
	CoreValueId,
} from "../src/compiler/core/core-ir.ts";
import type { CoreFunctionStore, CoreProgram } from "../src/compiler/core/core-store.ts";
import { CoreProgram as MutableCoreProgram } from "../src/compiler/core/core-store.ts";
import type { OptimizedCoreResult } from "../src/compiler/core/optimize.ts";
import { optimizeCore } from "../src/compiler/core/optimize.ts";
import {
	inspectCoreBlockHandler,
	inspectCoreBlockParameters,
	inspectCoreFunctionParameters,
	inspectCoreTerminatorPayload,
} from "./helpers/core-inspection.ts";
import { coreOperations } from "./helpers/core-inspection.ts";
import { programAnalysisContext } from "./helpers/core-program-analysis.ts";

const REFINED_CALL_EFFECTS: CoreInstructionEffects = {
	reads: ["host"],
	writes: [],
	mayThrow: true,
	maySuspend: false,
	mayGc: true,
	callsUserCode: false,
};

function program(): MutableCoreProgram {
	return new MutableCoreProgram(coreOpcodeRegistry, { stringConstants: [[]] });
}

function values(
	builder: CoreFunctionBuilder,
	block: CoreBlockId,
): ReadonlyArray<CoreValueId> {
	return inspectCoreBlockParameters(builder, block).map(({ value }) => value);
}

function expectConsistentEdges(fn: CoreFunctionStore): void {
	for (const block of fn.blockIds()) {
		for (const edge of coreTerminatorEdges(
			inspectCoreTerminatorPayload(fn, fn.blockTerminator(block)),
		)) {
			expect(fn.isBlockLive(edge.block)).toBe(true);
			expect(edge.arguments).toHaveLength(
				inspectCoreBlockParameters(fn, edge.block).length,
			);
			expect(inspectCoreBlockParameters(fn, edge.block)[0]?.role).not.toBe("exception");
		}
		const handlerEdge = inspectCoreBlockHandler(fn, block);
		if (handlerEdge === undefined) continue;
		expect(fn.isBlockLive(handlerEdge.block)).toBe(true);
		expect(inspectCoreBlockParameters(fn, handlerEdge.block)[0]?.role).toBe("exception");
		expect(handlerEdge.arguments.length + 1).toBe(
			inspectCoreBlockParameters(fn, handlerEdge.block).length,
		);
	}
}

function opcodesOf(fn: CoreFunctionStore): Array<string> {
	return coreOperations(fn).map(({ opcode }) => opcode);
}

function ordinaryPredecessorCount(
	program_: CoreProgram,
	fn: CoreFunctionStore,
	block: CoreBlockId,
): number {
	return buildCoreControlFlow(program_, fn.id).predecessors[block]!.filter(
		({ kind }) => kind === "ordinary",
	).length;
}

function optimizeVerified(
	program_: MutableCoreProgram,
	functions: ReadonlyArray<CoreFunctionId>,
): OptimizedCoreResult {
	expect(() =>
		verifyCoreProgram(program_, { stage: "construction" }, programAnalysisContext()),
	).not.toThrow();
	const result = optimizeCore(
		{ program: program_, context: programAnalysisContext() },
		{ verification: "per-pass" },
	);
	expect(() =>
		verifyCoreProgram(
			result.compilation.program,
			{ stage: "pre-target" },
			programAnalysisContext(),
		),
	).not.toThrow();
	for (const functionId of functions) {
		expectConsistentEdges(result.compilation.program.function(functionId));
	}
	return result;
}

describe("adversarial Core graphs", () => {
	it("keeps a nontrivial diamond join, its representation, and its fact metadata", () => {
		const program_ = program();
		const builder = new CoreFunctionBuilder(program_, { parameterCount: 1 });
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const left = builder.createBlock();
		const right = builder.createBlock();
		const merge = builder.createBlock([{ representation: "f64" }]);
		const condition = values(builder, entry)[0]!;
		const joined = values(builder, merge)[0]!;
		const fact = builder.addFact({
			kind: "locked-primordials",
			value: null,
			claims: [],
			validity: { kind: "world", fact: "primordials.locked" },
			obligations: [{ kind: "fallback", id: "generic-call" }],
			origin: "adversarial-core-test",
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		const [_deadInLeft] = builder.appendInstruction(left, "createNumber", [], {
			attributes: { value: 99 },
		});
		const [leftValue] = builder.appendInstruction(left, "createF64", [], {
			attributes: { value: 1.5 },
			outputRepresentations: ["f64"],
		});
		builder.setTerminator(left, {
			kind: "jump",
			edge: { block: merge, arguments: [leftValue!] },
		});
		const [rightValue] = builder.appendInstruction(right, "createF64", [], {
			attributes: { value: 2.5 },
			outputRepresentations: ["f64"],
		});
		const [copiedRight] = builder.appendInstruction(right, "move", [rightValue!], {
			outputRepresentations: ["f64"],
		});
		builder.setTerminator(right, {
			kind: "jump",
			edge: { block: merge, arguments: [copiedRight!] },
		});
		const [callee] = builder.appendInstruction(merge, "createUndefined", []);
		const [result] = builder.appendInstruction(
			merge,
			"call",
			[callee!, callee!, joined],
			{
				effectRefinement: { effects: REFINED_CALL_EFFECTS, proof: fact },
			},
		);
		builder.setTerminator(merge, { kind: "return", value: result! });
		const finished = builder.finish(entry);
		const optimized = optimizeVerified(program_, [finished.function]).compilation.program;
		const fn = optimized.function(finished.function);
		const join = [...fn.blockIds()].find(
			(block) => ordinaryPredecessorCount(optimized, fn, block) === 2,
		)!;
		const finalJoined = inspectCoreBlockParameters(fn, join)[0]!.value;
		expect(inspectCoreBlockParameters(fn, join)).toEqual([
			{ value: finalJoined, representation: "f64", role: "value" },
		]);
		expect(fn.valueRepresentation(finalJoined)).toBe("f64");
		const incoming = [...fn.blockIds()]
			.flatMap((block) =>
				coreTerminatorEdges(inspectCoreTerminatorPayload(fn, fn.blockTerminator(block))),
			)
			.filter((edge) => edge.block === join);
		const f64Values = coreOperations(fn)
			.filter(({ opcode }) => opcode === "createF64")
			.map(({ outputs }) => outputs[0]!);
		expect(incoming.map(({ arguments: arguments_ }) => arguments_)).toEqual(
			f64Values.map((value) => [value]),
		);
		expect(opcodesOf(fn)).not.toContain("move");
		expect(
			coreOperations(fn).some(
				({ opcode, attributes }) => opcode === "createNumber" && attributes.value === 99,
			),
		).toBe(false);
		const relocatedFact = [...fn.factIds()]
			.map((factId) => fn.fact(factId))
			.find(({ kind }) => kind === "locked-primordials")!;
		expect(relocatedFact).toMatchObject({
			validity: { kind: "world", fact: "primordials.locked" },
		});
		expect(coreOperations(fn).find(({ opcode }) => opcode === "call")?.id).toBeDefined();
		const call = coreOperations(fn).find(({ opcode }) => opcode === "call")!;
		expect(fn.instructionEffectRefinement(call.id)).toEqual({
			effects: REFINED_CALL_EFFECTS,
			proof: relocatedFact.id,
		});
	});

	it("keeps a reducible loop header, its carried value, and its backedge", () => {
		const program_ = program();
		const builder = new CoreFunctionBuilder(program_, { parameterCount: 1 });
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const header = builder.createBlock([{ representation: "boxed" }]);
		const body = builder.createBlock([{ representation: "boxed" }]);
		const exit = builder.createBlock([{ representation: "boxed" }]);
		const bound = values(builder, entry)[0]!;
		const carried = values(builder, header)[0]!;
		const [seed] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 0 },
		});
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: header, arguments: [seed!] },
		});
		const [test] = builder.appendInstruction(header, "binary", [carried, bound], {
			attributes: { operator: "<" },
		});
		builder.setTerminator(header, {
			kind: "branch",
			condition: test!,
			consequent: { block: body, arguments: [carried] },
			alternate: { block: exit, arguments: [carried] },
		});
		const bodyCarried = values(builder, body)[0]!;
		const [_deadInBody] = builder.appendInstruction(body, "createNumber", [], {
			attributes: { value: 77 },
		});
		const [step] = builder.appendInstruction(body, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [next] = builder.appendInstruction(body, "binary", [bodyCarried, step!], {
			attributes: { operator: "+" },
		});
		const [copiedNext] = builder.appendInstruction(body, "move", [next!]);
		builder.setTerminator(body, {
			kind: "jump",
			edge: { block: header, arguments: [copiedNext!] },
		});
		builder.setTerminator(exit, { kind: "return", value: values(builder, exit)[0]! });
		const finished = builder.finish(entry);
		const optimized = optimizeVerified(program_, [finished.function]).compilation.program;
		const fn = optimized.function(finished.function);
		const cfg = buildCoreControlFlow(optimized, finished.function);
		expect(cfg.loops).toHaveLength(1);
		const loop = cfg.loops[0]!;
		const finalHeader = loop.header;
		const finalBody = [...loop.latches][0]!;
		const finalCarried = inspectCoreBlockParameters(fn, finalHeader)[0]!.value;
		expect(inspectCoreBlockParameters(fn, finalHeader)).toEqual([
			{ value: finalCarried, representation: "f64", role: "value" },
		]);
		expect(ordinaryPredecessorCount(optimized, fn, finalHeader)).toBe(2);
		const bodyTerminator = inspectCoreTerminatorPayload(
			fn,
			fn.blockTerminator(finalBody),
		);
		const finalNext = coreOperations(fn).find(
			({ opcode, attributes }) => opcode === "binary" && attributes.operator === "+",
		)!.outputs[0]!;
		expect(bodyTerminator).toMatchObject({
			kind: "jump",
			edge: { block: finalHeader, arguments: [finalNext] },
		});
		expect(opcodesOf(fn)).not.toContain("move");
		expect(
			coreOperations(fn).some(
				({ opcode, attributes }) => opcode === "createNumber" && attributes.value === 77,
			),
		).toBe(false);
	});

	it("keeps irreducible control flow while canonicalizing its cyclic arguments", () => {
		const program_ = program();
		const builder = new CoreFunctionBuilder(program_, { parameterCount: 2 });
		const entry = builder.createBlock([
			{ representation: "boxed" },
			{ representation: "boxed" },
		]);
		const first = builder.createBlock([
			{ representation: "boxed" },
			{ representation: "boxed" },
		]);
		const second = builder.createBlock([
			{ representation: "boxed" },
			{ representation: "boxed" },
		]);
		const exit = builder.createBlock([{ representation: "boxed" }]);
		const [outerLeft, outerRight] = values(builder, entry);
		const [firstLeft, firstRight] = values(builder, first);
		const [secondLeft, secondRight] = values(builder, second);
		builder.setTerminator(entry, {
			kind: "branch",
			condition: outerLeft!,
			consequent: { block: first, arguments: [outerLeft!, outerRight!] },
			alternate: { block: second, arguments: [outerRight!, outerLeft!] },
		});
		builder.setTerminator(first, {
			kind: "branch",
			condition: firstLeft!,
			consequent: { block: second, arguments: [firstRight!, firstLeft!] },
			alternate: { block: exit, arguments: [firstLeft!] },
		});
		builder.setTerminator(second, {
			kind: "branch",
			condition: secondLeft!,
			consequent: { block: first, arguments: [secondRight!, secondLeft!] },
			alternate: { block: exit, arguments: [secondRight!] },
		});
		builder.setTerminator(exit, { kind: "return", value: values(builder, exit)[0]! });
		const finished = builder.finish(entry);
		const before = buildCoreControlFlow(program_, finished.function);
		expect(before.loops).toHaveLength(0);
		expect(before.irreducibleCycles).toHaveLength(1);
		expect(before.irreducibleCycles[0]!.entries).toEqual(new Set([first, second]));
		expect(before.dominates(first, second)).toBe(false);
		expect(before.dominates(second, first)).toBe(false);

		const optimized = optimizeVerified(program_, [finished.function]).compilation.program;
		const fn = optimized.function(finished.function);
		const cfg = buildCoreControlFlow(optimized, finished.function);
		expect([...fn.blockIds()]).toHaveLength(4);
		expect(cfg.loops).toHaveLength(0);
		expect(cfg.irreducibleCycles).toHaveLength(1);
		expect(cfg.dominates(entry, first)).toBe(true);
		expect(cfg.dominates(entry, second)).toBe(true);
		expect(cfg.dominates(first, second)).toBe(false);
		expect(cfg.dominates(second, first)).toBe(false);
		expect(ordinaryPredecessorCount(optimized, fn, first)).toBe(2);
		expect(ordinaryPredecessorCount(optimized, fn, second)).toBe(2);
		expect(inspectCoreBlockParameters(fn, first)).toEqual([]);
		expect(inspectCoreBlockParameters(fn, second)).toEqual([]);
		expect(inspectCoreBlockParameters(fn, exit)).toEqual([]);
		expect(inspectCoreTerminatorPayload(fn, fn.blockTerminator(first))).toMatchObject({
			kind: "branch",
			condition: outerLeft,
			consequent: { block: second, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		expect(inspectCoreTerminatorPayload(fn, fn.blockTerminator(second))).toMatchObject({
			kind: "branch",
			condition: outerRight,
			consequent: { block: first, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		expect(inspectCoreTerminatorPayload(fn, fn.blockTerminator(exit))).toEqual({
			kind: "return",
			value: outerLeft,
		});
	});

	it("detects a nested multi-entry cycle inside a single-entry SCC", () => {
		const program_ = program();
		const builder = new CoreFunctionBuilder(program_, { parameterCount: 2 });
		const entry = builder.createBlock([
			{ representation: "boxed" },
			{ representation: "boxed" },
		]);
		const first = builder.createBlock();
		const second = builder.createBlock();
		const exit = builder.createBlock();
		const [left, right] = values(builder, entry);
		builder.setTerminator(entry, {
			kind: "branch",
			condition: left!,
			consequent: { block: first, arguments: [] },
			alternate: { block: second, arguments: [] },
		});
		builder.setTerminator(first, {
			kind: "branch",
			condition: left!,
			consequent: { block: second, arguments: [] },
			alternate: { block: entry, arguments: [left!, right!] },
		});
		builder.setTerminator(second, {
			kind: "branch",
			condition: right!,
			consequent: { block: first, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		builder.setTerminator(exit, { kind: "return", value: left! });
		const finished = builder.finish(entry);
		const cfg = buildCoreControlFlow(program_, finished.function);
		expect(cfg.irreducibleCycles).toHaveLength(1);
		expect(cfg.irreducibleCycles[0]!.blocks).toEqual(new Set([first, second]));
		expect(cfg.irreducibleCycles[0]!.entries).toEqual(new Set([first, second]));
	});

	it("keeps handler inputs that are available at every protected block entry", () => {
		const program_ = program();
		const builder = new CoreFunctionBuilder(program_, { parameterCount: 1 });
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const body = builder.createBlock([{ representation: "boxed" }]);
		const handler = builder.createBlock([
			{ role: "exception", representation: "boxed" },
			{ representation: "boxed" },
		]);
		const input = values(builder, entry)[0]!;
		const [callee] = builder.appendInstruction(entry, "createUndefined", []);
		const [_deadInEntry] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 5 },
		});
		const [entryResult] = builder.appendInstruction(entry, "call", [callee!, callee!]);
		builder.setHandler(entry, handler, [input]);
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: body, arguments: [entryResult!] },
		});
		const bodyInput = values(builder, body)[0]!;
		const [bodyResult] = builder.appendInstruction(body, "call", [bodyInput, bodyInput]);
		builder.setHandler(body, handler, [callee!]);
		builder.setTerminator(body, { kind: "return", value: bodyResult! });
		const [exception, extra] = values(builder, handler);
		const [recovered] = builder.appendInstruction(
			handler,
			"binary",
			[exception!, extra!],
			{
				attributes: { operator: "+" },
			},
		);
		builder.setTerminator(handler, { kind: "return", value: recovered! });
		const finished = builder.finish(entry);
		const optimized = optimizeVerified(program_, [finished.function]).compilation.program;
		const fn = optimized.function(finished.function);
		const cfg = buildCoreControlFlow(optimized, finished.function);
		const finalHandler = [...fn.blockIds()].find(
			(block) => inspectCoreBlockParameters(fn, block)[0]?.role === "exception",
		)!;
		expect(inspectCoreBlockParameters(fn, finalHandler).map(({ role }) => role)).toEqual([
			"exception",
			"value",
		]);
		const protectedHandlers = [...fn.blockIds()]
			.map((block) => inspectCoreBlockHandler(fn, block))
			.filter((edge) => edge !== undefined);
		const finalCallee = coreOperations(fn).find(
			({ opcode }) => opcode === "createUndefined",
		)!.outputs[0]!;
		expect(protectedHandlers).toHaveLength(2);
		expect(protectedHandlers.every((edge) => edge.block === finalHandler)).toBe(true);
		expect(protectedHandlers.map(({ arguments: arguments_ }) => arguments_)).toEqual(
			expect.arrayContaining([[inspectCoreFunctionParameters(fn)[0]!], [finalCallee]]),
		);
		expect(
			cfg.predecessors[finalHandler]!.filter(({ kind }) => kind === "exceptional"),
		).toHaveLength(2);
		expect(
			cfg.predecessors[finalHandler]!.every(({ kind }) => kind === "exceptional"),
		).toBe(true);
		expect(
			coreOperations(fn).some(
				({ opcode, attributes }) => opcode === "createNumber" && attributes.value === 5,
			),
		).toBe(false);
	});

	it("keeps the resume dispatch of a terminal yield and of an await", () => {
		const program_ = program();
		const generator = new CoreFunctionBuilder(program_, { isGenerator: true });
		const generatorEntry = generator.createBlock();
		const thrown = generator.createBlock();
		const resumed = generator.createBlock();
		const returned = generator.createBlock();
		const completed = generator.createBlock();
		generator.appendInstruction(generatorEntry, "generatorStart", []);
		const [yielded] = generator.appendInstruction(generatorEntry, "createNumber", [], {
			attributes: { value: 42 },
		});
		const [sent, mode] = generator.appendInstruction(
			generatorEntry,
			"yield",
			[yielded!],
			{
				outputCount: 2,
			},
		);
		const [throwMode] = generator.appendInstruction(generatorEntry, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [isThrow] = generator.appendInstruction(
			generatorEntry,
			"binary",
			[mode!, throwMode!],
			{
				attributes: { operator: "===" },
			},
		);
		generator.setTerminator(generatorEntry, {
			kind: "branch",
			condition: isThrow!,
			consequent: { block: thrown, arguments: [] },
			alternate: { block: resumed, arguments: [] },
		});
		generator.setTerminator(thrown, { kind: "throw", value: sent! });
		const [returnMode] = generator.appendInstruction(resumed, "createNumber", [], {
			attributes: { value: 2 },
		});
		const [isReturn] = generator.appendInstruction(
			resumed,
			"binary",
			[mode!, returnMode!],
			{
				attributes: { operator: "===" },
			},
		);
		generator.setTerminator(resumed, {
			kind: "branch",
			condition: isReturn!,
			consequent: { block: returned, arguments: [] },
			alternate: { block: completed, arguments: [] },
		});
		generator.setTerminator(returned, { kind: "return", value: sent! });
		const [completion] = generator.appendInstruction(completed, "createUndefined", []);
		generator.setTerminator(completed, { kind: "return", value: completion! });
		const generatorFinished = generator.finish(generatorEntry);

		const asynchronous = new CoreFunctionBuilder(program_, { isAsync: true });
		const asyncEntry = asynchronous.createBlock();
		const rejected = asynchronous.createBlock();
		const fulfilled = asynchronous.createBlock();
		asynchronous.appendInstruction(asyncEntry, "asyncStart", []);
		const [awaited] = asynchronous.appendInstruction(asyncEntry, "createUndefined", []);
		const [settled, asyncMode] = asynchronous.appendInstruction(
			asyncEntry,
			"await",
			[awaited!],
			{
				outputCount: 2,
			},
		);
		const [rejectMode] = asynchronous.appendInstruction(asyncEntry, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [isRejected] = asynchronous.appendInstruction(
			asyncEntry,
			"binary",
			[asyncMode!, rejectMode!],
			{
				attributes: { operator: "===" },
			},
		);
		asynchronous.setTerminator(asyncEntry, {
			kind: "branch",
			condition: isRejected!,
			consequent: { block: rejected, arguments: [] },
			alternate: { block: fulfilled, arguments: [] },
		});
		asynchronous.setTerminator(rejected, { kind: "throw", value: settled! });
		asynchronous.setTerminator(fulfilled, { kind: "return", value: settled! });
		const asyncFinished = asynchronous.finish(asyncEntry);

		const optimized = optimizeVerified(program_, [
			generatorFinished.function,
			asyncFinished.function,
		]).compilation.program;
		const generatorFn = optimized.function(generatorFinished.function);
		const asyncFn = optimized.function(asyncFinished.function);
		expect([...generatorFn.blockIds()]).toHaveLength(5);
		const yieldInstruction = coreOperations(generatorFn).find(
			({ opcode }) => opcode === "yield",
		)!;
		expect(yieldInstruction.outputs).toHaveLength(2);
		expect(yieldInstruction.attributes.terminal).toBe(true);
		expect(
			[...generatorFn.blockIds()].filter(
				(block) =>
					inspectCoreTerminatorPayload(generatorFn, generatorFn.blockTerminator(block))
						.kind === "throw",
			),
		).toHaveLength(1);
		expect(
			[...generatorFn.blockIds()].filter(
				(block) =>
					inspectCoreTerminatorPayload(generatorFn, generatorFn.blockTerminator(block))
						.kind === "return",
			),
		).toHaveLength(2);
		expect(opcodesOf(generatorFn)).toContain("generatorStart");
		expect([...asyncFn.blockIds()]).toHaveLength(3);
		const awaitInstruction = coreOperations(asyncFn).find(
			({ opcode }) => opcode === "await",
		)!;
		const [finalSettled] = awaitInstruction.outputs;
		const asyncTerminations = [...asyncFn.blockIds()].map((block) =>
			inspectCoreTerminatorPayload(asyncFn, asyncFn.blockTerminator(block)),
		);
		expect(asyncTerminations.find(({ kind }) => kind === "throw")).toEqual({
			kind: "throw",
			value: finalSettled,
		});
		expect(asyncTerminations.find(({ kind }) => kind === "return")).toEqual({
			kind: "return",
			value: finalSettled,
		});
	});

	it("keeps a guard, its proven fact, and an independent epoch fact", () => {
		const program_ = program();
		const builder = new CoreFunctionBuilder(program_, { parameterCount: 2 });
		const entry = builder.createBlock([
			{ representation: "boxed" },
			{ representation: "boxed" },
		]);
		const fast = builder.createBlock([{ representation: "boxed" }]);
		const slow = builder.createBlock([{ representation: "boxed" }]);
		const [condition, input] = values(builder, entry);
		const [_deadInEntry] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 13 },
		});
		const [copiedInput] = builder.appendInstruction(entry, "move", [input!]);
		const provenFact = builder.setGuardTerminator(entry, {
			condition: condition!,
			success: { block: fast, arguments: [copiedInput!] },
			fallback: { block: slow, arguments: [copiedInput!] },
			fact: {
				kind: "exact-call-target",
				value: 3,
				claims: [],
				origin: "adversarial-core-test",
				obligations: [{ kind: "fallback", id: "generic-call" }],
			},
		});
		const _epochFact = builder.addFact({
			kind: "shape-epoch",
			value: "object-shapes",
			claims: [],
			validity: { kind: "epoch", family: "object-shapes" },
			obligations: [{ kind: "fallback", id: "shape-deopt" }],
			origin: "adversarial-core-test",
		});
		const fastInput = values(builder, fast)[0]!;
		const [fastResult] = builder.appendInstruction(fast, "call", [fastInput, fastInput], {
			effectRefinement: { effects: REFINED_CALL_EFFECTS, proof: provenFact },
		});
		builder.setTerminator(fast, { kind: "return", value: fastResult! });
		const slowInput = values(builder, slow)[0]!;
		const [slowResult] = builder.appendInstruction(slow, "call", [slowInput, slowInput]);
		builder.setTerminator(slow, { kind: "return", value: slowResult! });
		const finished = builder.finish(entry);
		const optimized = optimizeVerified(program_, [finished.function]).compilation.program;
		const fn = optimized.function(finished.function);
		const terminator = inspectCoreTerminatorPayload(fn, fn.blockTerminator(fn.entry));
		const finalProvenFact = [...fn.factIds()]
			.map((factId) => fn.fact(factId))
			.find(({ kind }) => kind === "exact-call-target")!;
		const finalEpochFact = [...fn.factIds()]
			.map((factId) => fn.fact(factId))
			.find(({ kind }) => kind === "shape-epoch")!;
		expect(terminator).toMatchObject({
			kind: "guard",
			fact: finalProvenFact.id,
			success: { arguments: [] },
			fallback: { arguments: [] },
		});
		expect(finalProvenFact.validity).toEqual({
			kind: "guard",
			instruction: fn.blockTerminator(fn.entry),
		});
		expect(finalEpochFact).toMatchObject({
			validity: { kind: "epoch", family: "object-shapes" },
			obligations: [{ kind: "fallback", id: "shape-deopt" }],
		});
		const fastBlock = terminator.kind === "guard" ? terminator.success.block : undefined;
		const fastCall = coreOperations(fn).find(
			(operation) => operation.block === fastBlock && operation.opcode === "call",
		)!;
		const finalInput = inspectCoreFunctionParameters(fn)[1]!;
		expect(fastCall.inputs).toEqual([finalInput, finalInput]);
		expect(fn.instructionEffectRefinement(fastCall.id)).toEqual({
			effects: REFINED_CALL_EFFECTS,
			proof: finalProvenFact.id,
		});
		expect(opcodesOf(fn)).not.toContain("move");
		expect(
			coreOperations(fn).some(
				({ opcode, attributes }) => opcode === "createNumber" && attributes.value === 13,
			),
		).toBe(false);
	});
});

interface GraphVariation {
	readonly join: boolean;
	readonly branch: "dynamic" | "constant";
	readonly loop: boolean;
	readonly deadProducer: boolean;
	readonly copy: boolean;
}

const GRAPH_VARIATIONS: ReadonlyArray<GraphVariation> = [false, true].flatMap((join) =>
	(join ? (["dynamic", "constant"] as const) : (["dynamic"] as const)).flatMap((branch) =>
		[false, true].flatMap((loop) =>
			[false, true].flatMap((deadProducer) =>
				[false, true].map(
					(copy): GraphVariation => ({ join, branch, loop, deadProducer, copy }),
				),
			),
		),
	),
);

interface BuiltVariation {
	readonly program: MutableCoreProgram;
	readonly function: CoreFunctionId;
	readonly header?: CoreBlockId;
	readonly joinParameter?: CoreValueId;
	readonly deadValue?: CoreValueId;
}

function buildVariation(variation: GraphVariation): BuiltVariation {
	const program_ = program();
	const builder = new CoreFunctionBuilder(program_, { parameterCount: 1 });
	const entry = builder.createBlock([{ representation: "boxed" }]);
	const guardValue = values(builder, entry)[0]!;
	const deadValue = variation.deadProducer
		? builder.appendInstruction(entry, "createNumber", [], {
				attributes: { value: 11 },
			})[0]
		: undefined;
	let current = entry;
	let header: CoreBlockId | undefined;
	let carried: CoreValueId | undefined;
	if (variation.loop) {
		header = builder.createBlock([{ representation: "boxed" }]);
		carried = values(builder, header)[0]!;
		const [seed] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 0 },
		});
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: header, arguments: [seed!] },
		});
		current = header;
	}
	let joinParameter: CoreValueId | undefined;
	let value: CoreValueId;
	if (variation.join) {
		const left = builder.createBlock();
		const right = builder.createBlock();
		const merge = builder.createBlock([{ representation: "boxed" }]);
		joinParameter = values(builder, merge)[0]!;
		const condition =
			variation.branch === "constant"
				? builder.appendInstruction(current, "createBoolean", [], {
						attributes: { value: true },
					})[0]!
				: guardValue;
		builder.setTerminator(current, {
			kind: "branch",
			condition,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		const [leftValue] = builder.appendInstruction(left, "createNumber", [], {
			attributes: { value: 1 },
		});
		builder.setTerminator(left, {
			kind: "jump",
			edge: { block: merge, arguments: [leftValue!] },
		});
		const [rightValue] = builder.appendInstruction(right, "createNumber", [], {
			attributes: { value: 2 },
		});
		builder.setTerminator(right, {
			kind: "jump",
			edge: { block: merge, arguments: [rightValue!] },
		});
		current = merge;
		value = joinParameter;
	} else {
		value = builder.appendInstruction(current, "createNumber", [], {
			attributes: { value: 3 },
		})[0]!;
	}
	if (variation.copy) {
		const [first] = builder.appendInstruction(current, "move", [value]);
		value = builder.appendInstruction(current, "move", [first!])[0]!;
	}
	if (header !== undefined) {
		value = builder.appendInstruction(current, "binary", [value, carried!], {
			attributes: { operator: "+" },
		})[0]!;
		const latch = builder.createBlock([{ representation: "boxed" }]);
		const exit = builder.createBlock([{ representation: "boxed" }]);
		builder.setTerminator(current, {
			kind: "branch",
			condition: guardValue,
			consequent: { block: latch, arguments: [value] },
			alternate: { block: exit, arguments: [value] },
		});
		builder.setTerminator(latch, {
			kind: "jump",
			edge: { block: header, arguments: [values(builder, latch)[0]!] },
		});
		builder.setTerminator(exit, { kind: "return", value: values(builder, exit)[0]! });
	} else {
		builder.setTerminator(current, { kind: "return", value });
	}
	const finished = builder.finish(entry);
	return {
		program: program_,
		function: finished.function,
		...(header === undefined ? {} : { header }),
		...(joinParameter === undefined ? {} : { joinParameter }),
		...(deadValue === undefined ? {} : { deadValue }),
	};
}

function variationLabel(variation: GraphVariation): string {
	return [
		variation.join ? `${variation.branch} join` : "no join",
		variation.loop ? "loop edge" : "straight line",
		variation.deadProducer ? "dead producer" : "no dead producer",
		variation.copy ? "copies" : "no copies",
	].join(", ");
}

describe("generated valid Core graph variations", () => {
	for (const variation of GRAPH_VARIATIONS) {
		it(`composes passes over ${variationLabel(variation)}`, () => {
			const built = buildVariation(variation);
			const result = optimizeVerified(built.program, [built.function]);
			const fn = result.compilation.program.function(built.function);
			const cfg = buildCoreControlFlow(result.compilation.program, built.function);
			expect(opcodesOf(fn)).not.toContain("move");
			if (built.deadValue !== undefined) {
				expect(
					coreOperations(fn).some(
						({ opcode, attributes }) =>
							opcode === "createNumber" && attributes.value === 11,
					),
				).toBe(false);
			}
			if (built.joinParameter !== undefined) {
				const join = [...fn.blockIds()].find(
					(block) =>
						block !== cfg.loops[0]?.header &&
						ordinaryPredecessorCount(result.compilation.program, fn, block) === 2,
				);
				expect(join === undefined ? 0 : inspectCoreBlockParameters(fn, join).length).toBe(
					variation.branch === "dynamic" ? 1 : 0,
				);
			}
			if (built.header === undefined) {
				expect(cfg.loops).toHaveLength(0);
			} else {
				expect(cfg.loops).toHaveLength(1);
				expect(inspectCoreBlockParameters(fn, cfg.loops[0]!.header)).toHaveLength(1);
				expect(
					ordinaryPredecessorCount(result.compilation.program, fn, cfg.loops[0]!.header),
				).toBe(2);
			}
		});
	}
});
