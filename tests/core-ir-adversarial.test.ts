import { describe, expect, it } from "vitest";
import {
	buildCoreControlFlow,
	coreTerminatorEdges,
} from "../src/compiler/core/core-ir-control-flow.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { executeCoreOptimizations } from "../src/compiler/core/core-ir-opt.ts";
import type { CoreOptimizationResult } from "../src/compiler/core/core-ir-opt.ts";
import { verifyCoreProgram } from "../src/compiler/core/core-ir-verifier.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-ir.ts";
import type {
	CoreBlockId,
	CoreFunction,
	CoreInstruction,
	CoreInstructionEffects,
	CoreProgram,
	CoreValueId,
} from "../src/compiler/core/core-ir.ts";

/**
 * Hand-built Core graphs that the frontend never emits: irreducible strongly
 * connected components, swapped block arguments, hand-placed certificates, and
 * generated pass-composition variations. Each graph is valid on entry, so any
 * failure names a verifier, optimizer, or CFG defect rather than a bad fixture.
 */

function coreProgramOf(functions: ReadonlyArray<CoreFunction>): CoreProgram {
	return {
		functions,
		stringConstants: [[]],
		bigintConstants: [],
		literalTemplateData: [],
		sourcePositions: [],
		globalCount: 0,
	};
}

/** Narrowing of `call`, whose baseline effects are host reads and host writes. */
const REFINED_CALL_EFFECTS: CoreInstructionEffects = {
	reads: ["host"],
	writes: [],
	mayThrow: true,
	maySuspend: false,
	mayGc: true,
	callsUserCode: false,
};

function structuralProgram(program: CoreProgram) {
	return program.functions.map((fn) => ({
		functionIndex: fn.functionIndex,
		entry: fn.entry,
		bodyEntry: fn.bodyEntry,
		parameters: [...fn.parameters],
		values: fn.values.map(({ id, representation }) => ({ id, representation })),
		facts: fn.facts.map(({ id, kind, validity, obligations }) => ({
			id,
			kind,
			validity,
			obligations,
		})),
		regions: fn.regions.map((region) => ({ ...region })),
		blocks: fn.blocks.map((block) => ({
			id: block.id,
			parameters: block.parameters,
			handler: block.handler,
			instructions: block.instructions.map(
				({ id, opcode, inputs, outputs, attributes, effectRefinement }) => ({
					id,
					opcode,
					inputs,
					outputs,
					attributes,
					effectRefinement,
				}),
			),
			terminator: block.terminator,
		})),
	}));
}

/** Edge arity is the contract every CFG rewrite has to re-establish. */
function expectConsistentEdges(fn: CoreFunction): void {
	for (const block of fn.blocks) {
		for (const edge of coreTerminatorEdges(block.terminator)) {
			const target = fn.blocks[edge.block];
			expect(target).toBeDefined();
			expect(edge.arguments).toHaveLength(target!.parameters.length);
			expect(target!.parameters[0]?.role).not.toBe("exception");
		}
		if (block.handler === undefined) continue;
		const handler = fn.blocks[block.handler.block];
		expect(handler).toBeDefined();
		expect(handler!.parameters[0]?.role).toBe("exception");
		expect(block.handler.arguments.length + 1).toBe(handler!.parameters.length);
	}
}

function opcodesOf(fn: CoreFunction): Array<string> {
	return fn.blocks.flatMap(({ instructions }) =>
		instructions.map(({ opcode }) => opcode),
	);
}

function instructionsOf(fn: CoreFunction): Array<CoreInstruction> {
	return fn.blocks.flatMap(({ instructions }) => instructions);
}

function definesValue(fn: CoreFunction, value: CoreValueId): boolean {
	return fn.values.some(({ id }) => id === value);
}

function ordinaryPredecessorCount(fn: CoreFunction, block: CoreBlockId): number {
	return buildCoreControlFlow(fn, coreOpcodeRegistry).predecessors[block]!.filter(
		({ kind }) => kind === "ordinary",
	).length;
}

/**
 * Verify with the real whole-program verifier before and after optimization,
 * optimize with per-pass verification so a broken graph names its pass, then
 * prove the result is a fixpoint by rerunning the whole pipeline on it.
 */
function optimizeVerified(program: CoreProgram): CoreOptimizationResult {
	expect(() =>
		verifyCoreProgram(program, coreOpcodeRegistry, { stage: "construction" }),
	).not.toThrow();
	const result = executeCoreOptimizations(program, { verification: "per-pass" });
	expect(() =>
		verifyCoreProgram(result.program, coreOpcodeRegistry, { stage: "pre-target" }),
	).not.toThrow();
	const rerun = executeCoreOptimizations(result.program, { verification: "per-pass" });
	expect(() =>
		verifyCoreProgram(rerun.program, coreOpcodeRegistry, { stage: "pre-target" }),
	).not.toThrow();
	expect(structuralProgram(rerun.program)).toEqual(structuralProgram(result.program));
	for (const fn of result.program.functions) expectConsistentEdges(fn);
	return result;
}

describe("adversarial Core graphs", () => {
	it("keeps a nontrivial diamond join, its representation, and its fact metadata", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 1 });
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const left = builder.createBlock();
		const right = builder.createBlock();
		const merge = builder.createBlock([{ representation: "f64" }]);
		const condition = builder.block(entry).parameters[0]!.value;
		const joined = builder.block(merge).parameters[0]!.value;
		const fact = builder.addFact({
			kind: "locked-primordials",
			value: null,
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
		const [deadInLeft] = builder.appendInstruction(left, "createNumber", [], {
			attributes: { value: 99 },
		});
		const [leftValue] = builder.appendInstruction(left, "createF64", [], {
			attributes: { value: 1 },
			outputRepresentations: ["f64"],
		});
		builder.setTerminator(left, {
			kind: "jump",
			edge: { block: merge, arguments: [leftValue!] },
		});
		const [rightValue] = builder.appendInstruction(right, "createF64", [], {
			attributes: { value: 2 },
			outputRepresentations: ["f64"],
		});
		// A copy on the incoming edge forces copy propagation to rewrite the block
		// argument rather than the join parameter.
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
			{ effectRefinement: { effects: REFINED_CALL_EFFECTS, proof: fact } },
		);
		builder.setTerminator(merge, { kind: "return", value: result! });

		const optimized = optimizeVerified(coreProgramOf([builder.finish(entry)])).program;
		const fn = optimized.functions[0]!;
		const join = fn.blocks.find(({ id }) => ordinaryPredecessorCount(fn, id) === 2)!;

		expect(join.parameters).toEqual([
			{ value: joined, representation: "f64", role: "value" },
		]);
		expect(fn.values.find(({ id }) => id === joined)?.representation).toBe("f64");
		const incoming = fn.blocks
			.flatMap((block) => coreTerminatorEdges(block.terminator))
			.filter((edge) => edge.block === join.id);
		expect(incoming.map(({ arguments: values }) => values)).toEqual([
			[leftValue],
			[rightValue],
		]);
		expect(opcodesOf(fn)).not.toContain("move");
		expect(definesValue(fn, deadInLeft!)).toBe(false);
		expect(fn.facts).toEqual([
			expect.objectContaining({
				id: fact,
				validity: { kind: "world", fact: "primordials.locked" },
			}),
		]);
		expect(
			instructionsOf(fn).find(({ opcode }) => opcode === "call")?.effectRefinement,
		).toEqual({ effects: REFINED_CALL_EFFECTS, proof: fact });
	});

	it("keeps a reducible loop header, its carried value, and its backedge", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 1 });
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const header = builder.createBlock([{ representation: "boxed" }]);
		const body = builder.createBlock([{ representation: "boxed" }]);
		const exit = builder.createBlock([{ representation: "boxed" }]);
		const bound = builder.block(entry).parameters[0]!.value;
		const carried = builder.block(header).parameters[0]!.value;
		const [seed] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 0 },
		});
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: header, arguments: [seed!] },
		});
		// The test compares a loop-carried block parameter, so constant folding can
		// never resolve it and the loop must survive every round.
		const [test] = builder.appendInstruction(header, "binary", [carried, bound], {
			attributes: { operator: "<" },
		});
		builder.setTerminator(header, {
			kind: "branch",
			condition: test!,
			consequent: { block: body, arguments: [carried] },
			alternate: { block: exit, arguments: [carried] },
		});
		const bodyCarried = builder.block(body).parameters[0]!.value;
		const [deadInBody] = builder.appendInstruction(body, "createNumber", [], {
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
		builder.setTerminator(exit, {
			kind: "return",
			value: builder.block(exit).parameters[0]!.value,
		});

		const optimized = optimizeVerified(coreProgramOf([builder.finish(entry)])).program;
		const fn = optimized.functions[0]!;
		const cfg = buildCoreControlFlow(fn, coreOpcodeRegistry);

		expect(cfg.loops).toHaveLength(1);
		expect(cfg.loops[0]!.header).toBe(header);
		expect(cfg.loops[0]!.latches).toEqual(new Set([body]));
		expect(fn.blocks[header]!.parameters).toEqual([
			{ value: carried, representation: "boxed", role: "value" },
		]);
		expect(ordinaryPredecessorCount(fn, header)).toBe(2);
		expect(fn.blocks[body]!.terminator).toMatchObject({
			kind: "jump",
			edge: { block: header, arguments: [next] },
		});
		expect(opcodesOf(fn)).not.toContain("move");
		expect(definesValue(fn, deadInBody!)).toBe(false);
	});

	it("keeps irreducible control flow while canonicalizing its cyclic arguments", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 2 });
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
		const [outerLeft, outerRight] = builder
			.block(entry)
			.parameters.map(({ value }) => value);
		const [firstLeft, firstRight] = builder
			.block(first)
			.parameters.map(({ value }) => value);
		const [secondLeft, secondRight] = builder
			.block(second)
			.parameters.map(({ value }) => value);
		// Both component members are entered directly from outside, so neither
		// dominates the other and no backedge exists to make the loop natural.
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
		builder.setTerminator(exit, {
			kind: "return",
			value: builder.block(exit).parameters[0]!.value,
		});

		const source = builder.finish(entry);
		const cfgBefore = buildCoreControlFlow(source, coreOpcodeRegistry);
		expect(cfgBefore.loops).toHaveLength(0);
		expect(cfgBefore.irreducibleCycles).toHaveLength(1);
		expect(cfgBefore.irreducibleCycles[0]!.entries).toEqual(new Set([first, second]));
		expect(cfgBefore.dominates(first, second)).toBe(false);
		expect(cfgBefore.dominates(second, first)).toBe(false);

		const optimized = optimizeVerified(coreProgramOf([source])).program;
		const fn = optimized.functions[0]!;
		const cfg = buildCoreControlFlow(fn, coreOpcodeRegistry);

		expect(fn.blocks).toHaveLength(4);
		expect(cfg.loops).toHaveLength(0);
		expect(cfg.irreducibleCycles).toHaveLength(1);
		expect(cfg.dominates(entry, first)).toBe(true);
		expect(cfg.dominates(entry, second)).toBe(true);
		expect(cfg.dominates(first, second)).toBe(false);
		expect(cfg.dominates(second, first)).toBe(false);
		expect(ordinaryPredecessorCount(fn, first)).toBe(2);
		expect(ordinaryPredecessorCount(fn, second)).toBe(2);
		expect(fn.blocks[first]!.terminator).toMatchObject({
			kind: "branch",
			condition: outerLeft,
			consequent: { block: second, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		expect(fn.blocks[second]!.terminator).toMatchObject({
			kind: "branch",
			condition: outerRight,
			consequent: { block: first, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		expect(fn.blocks[first]!.parameters).toEqual([]);
		expect(fn.blocks[second]!.parameters).toEqual([]);
		expect(fn.blocks[exit]!.parameters).toEqual([]);
		expect(fn.blocks[exit]!.terminator).toMatchObject({
			kind: "return",
			value: outerLeft,
		});
	});

	it("detects a nested multi-entry cycle inside a single-entry SCC", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 2 });
		const entry = builder.createBlock([
			{ representation: "boxed" },
			{ representation: "boxed" },
		]);
		const first = builder.createBlock();
		const second = builder.createBlock();
		const exit = builder.createBlock();
		const [left, right] = builder.block(entry).parameters.map(({ value }) => value);
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

		const cfg = buildCoreControlFlow(builder.finish(entry), coreOpcodeRegistry);
		expect(cfg.irreducibleCycles).toHaveLength(1);
		expect(cfg.irreducibleCycles[0]!.blocks).toEqual(new Set([first, second]));
		expect(cfg.irreducibleCycles[0]!.entries).toEqual(new Set([first, second]));
	});

	it("keeps handler inputs that are available at every protected block entry", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 1 });
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const body = builder.createBlock([{ representation: "boxed" }]);
		const handler = builder.createBlock([
			{ role: "exception", representation: "boxed" },
			{ representation: "boxed" },
		]);
		const input = builder.block(entry).parameters[0]!.value;
		const [callee] = builder.appendInstruction(entry, "createUndefined", []);
		const [deadInEntry] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 5 },
		});
		const [entryResult] = builder.appendInstruction(entry, "call", [callee!, callee!]);
		builder.setHandler(entry, handler, [input]);
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: body, arguments: [entryResult!] },
		});
		const bodyInput = builder.block(body).parameters[0]!.value;
		const [bodyResult] = builder.appendInstruction(body, "call", [bodyInput, bodyInput]);
		// `callee` is defined in the dominating entry block, so it is live at the
		// handler entry even though the exceptional edge leaves `body`.
		builder.setHandler(body, handler, [callee!]);
		builder.setTerminator(body, { kind: "return", value: bodyResult! });
		const [exception, extra] = builder
			.block(handler)
			.parameters.map(({ value }) => value);
		const [recovered] = builder.appendInstruction(
			handler,
			"binary",
			[exception!, extra!],
			{ attributes: { operator: "+" } },
		);
		builder.setTerminator(handler, { kind: "return", value: recovered! });

		const optimized = optimizeVerified(coreProgramOf([builder.finish(entry)])).program;
		const fn = optimized.functions[0]!;
		const cfg = buildCoreControlFlow(fn, coreOpcodeRegistry);

		expect(fn.blocks[handler]!.parameters.map(({ role }) => role)).toEqual([
			"exception",
			"value",
		]);
		expect(fn.blocks[entry]!.handler).toEqual({ block: handler, arguments: [input] });
		expect(fn.blocks[body]!.handler).toEqual({ block: handler, arguments: [callee] });
		expect(
			cfg.predecessors[handler]!.filter(({ kind }) => kind === "exceptional"),
		).toHaveLength(2);
		expect(cfg.predecessors[handler]!.every(({ kind }) => kind === "exceptional")).toBe(
			true,
		);
		expect(definesValue(fn, deadInEntry!)).toBe(false);
	});

	it("keeps the resume dispatch of a terminal yield and of an await", () => {
		const generator = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
			isGenerator: true,
		});
		const generatorEntry = generator.createBlock();
		const thrown = generator.createBlock();
		const resumed = generator.createBlock();
		const returned = generator.createBlock();
		const finished = generator.createBlock();
		generator.appendInstruction(generatorEntry, "generatorStart", []);
		const [yielded] = generator.appendInstruction(generatorEntry, "createNumber", [], {
			attributes: { value: 42 },
		});
		const [sent, mode] = generator.appendInstruction(
			generatorEntry,
			"yield",
			[yielded!],
			{ outputCount: 2 },
		);
		// Canonical resume protocol: mode 1 throws the sent value at the suspend
		// point, mode 2 returns it, and anything else continues the body.
		const [throwMode] = generator.appendInstruction(generatorEntry, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [isThrow] = generator.appendInstruction(
			generatorEntry,
			"binary",
			[mode!, throwMode!],
			{ attributes: { operator: "===" } },
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
			{ attributes: { operator: "===" } },
		);
		generator.setTerminator(resumed, {
			kind: "branch",
			condition: isReturn!,
			consequent: { block: returned, arguments: [] },
			alternate: { block: finished, arguments: [] },
		});
		generator.setTerminator(returned, { kind: "return", value: sent! });
		const [completion] = generator.appendInstruction(finished, "createUndefined", []);
		generator.setTerminator(finished, { kind: "return", value: completion! });

		const asynchronous = new CoreFunctionBuilder(1, coreOpcodeRegistry, {
			isAsync: true,
		});
		const asyncEntry = asynchronous.createBlock();
		const rejected = asynchronous.createBlock();
		const fulfilled = asynchronous.createBlock();
		asynchronous.appendInstruction(asyncEntry, "asyncStart", []);
		const [awaited] = asynchronous.appendInstruction(asyncEntry, "createUndefined", []);
		const [settled, asyncMode] = asynchronous.appendInstruction(
			asyncEntry,
			"await",
			[awaited!],
			{ outputCount: 2 },
		);
		const [rejectMode] = asynchronous.appendInstruction(asyncEntry, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [isRejected] = asynchronous.appendInstruction(
			asyncEntry,
			"binary",
			[asyncMode!, rejectMode!],
			{ attributes: { operator: "===" } },
		);
		asynchronous.setTerminator(asyncEntry, {
			kind: "branch",
			condition: isRejected!,
			consequent: { block: rejected, arguments: [] },
			alternate: { block: fulfilled, arguments: [] },
		});
		asynchronous.setTerminator(rejected, { kind: "throw", value: settled! });
		asynchronous.setTerminator(fulfilled, { kind: "return", value: settled! });

		const optimized = optimizeVerified(
			coreProgramOf([generator.finish(generatorEntry), asynchronous.finish(asyncEntry)]),
		).program;
		const generatorFunction = optimized.functions[0]!;
		const asyncFunction = optimized.functions[1]!;

		expect(generatorFunction.blocks).toHaveLength(5);
		const yieldInstruction = instructionsOf(generatorFunction).find(
			({ opcode }) => opcode === "yield",
		)!;
		expect(yieldInstruction.outputs).toEqual([sent, mode]);
		expect(yieldInstruction.attributes.terminal).toBe(true);
		expect(
			generatorFunction.blocks.filter(({ terminator }) => terminator.kind === "throw"),
		).toHaveLength(1);
		expect(
			generatorFunction.blocks.filter(({ terminator }) => terminator.kind === "return"),
		).toHaveLength(2);
		expect(opcodesOf(generatorFunction)).toContain("generatorStart");

		expect(asyncFunction.blocks).toHaveLength(3);
		const awaitInstruction = instructionsOf(asyncFunction).find(
			({ opcode }) => opcode === "await",
		)!;
		expect(awaitInstruction.outputs).toEqual([settled, asyncMode]);
		expect(asyncFunction.blocks[rejected]!.terminator).toMatchObject({
			kind: "throw",
			value: settled,
		});
		expect(asyncFunction.blocks[fulfilled]!.terminator).toMatchObject({
			kind: "return",
			value: settled,
		});
	});

	it("keeps a guard, its proven fact, and an independent epoch fact", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 2 });
		const entry = builder.createBlock([
			{ representation: "boxed" },
			{ representation: "boxed" },
		]);
		const fast = builder.createBlock([{ representation: "boxed" }]);
		const slow = builder.createBlock([{ representation: "boxed" }]);
		const [condition, input] = builder.block(entry).parameters.map(({ value }) => value);
		const [deadInEntry] = builder.appendInstruction(entry, "createNumber", [], {
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
				origin: "adversarial-core-test",
				obligations: [{ kind: "fallback", id: "generic-call" }],
			},
		});
		// An epoch fact is only valid while something can deoptimize on it, so it
		// carries a fallback obligation and never refines an instruction directly.
		const epochFact = builder.addFact({
			kind: "shape-epoch",
			value: "object-shapes",
			validity: { kind: "epoch", family: "object-shapes" },
			obligations: [{ kind: "fallback", id: "shape-deopt" }],
			origin: "adversarial-core-test",
		});
		const fastInput = builder.block(fast).parameters[0]!.value;
		const [fastResult] = builder.appendInstruction(fast, "call", [fastInput, fastInput], {
			effectRefinement: { effects: REFINED_CALL_EFFECTS, proof: provenFact },
		});
		builder.setTerminator(fast, { kind: "return", value: fastResult! });
		const slowInput = builder.block(slow).parameters[0]!.value;
		const [slowResult] = builder.appendInstruction(slow, "call", [slowInput, slowInput]);
		builder.setTerminator(slow, { kind: "return", value: slowResult! });

		const optimized = optimizeVerified(coreProgramOf([builder.finish(entry)])).program;
		const fn = optimized.functions[0]!;
		const terminator = fn.blocks[entry]!.terminator;

		expect(terminator).toMatchObject({
			kind: "guard",
			fact: provenFact,
			success: { block: fast, arguments: [] },
			fallback: { block: slow, arguments: [] },
		});
		expect(fn.facts.find(({ id }) => id === provenFact)?.validity).toEqual({
			kind: "guard",
			instruction: terminator.id,
		});
		expect(fn.facts.find(({ id }) => id === epochFact)).toMatchObject({
			validity: { kind: "epoch", family: "object-shapes" },
			obligations: [{ kind: "fallback", id: "shape-deopt" }],
		});
		const fastCall = fn.blocks[fast]!.instructions.find(
			({ opcode }) => opcode === "call",
		);
		expect(fastCall?.inputs).toEqual([input, input]);
		expect(fastCall?.effectRefinement).toEqual({
			effects: REFINED_CALL_EFFECTS,
			proof: provenFact,
		});
		expect(opcodesOf(fn)).not.toContain("move");
		expect(definesValue(fn, deadInEntry!)).toBe(false);
		expect(definesValue(fn, copiedInput!)).toBe(false);
	});

	it("keeps a certified region intact while unrelated passes clean up around it", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
		const entry = builder.createBlock();
		const body = builder.createBlock([{ representation: "boxed" }]);
		const [callee] = builder.appendInstruction(entry, "createUndefined", []);
		const [certified] = builder.appendInstruction(entry, "call", [callee!, callee!]);
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: body, arguments: [certified!] },
		});
		const carried = builder.block(body).parameters[0]!.value;
		const [firstDuplicate] = builder.appendInstruction(body, "createNumber", [], {
			attributes: { value: 3 },
		});
		const [secondDuplicate] = builder.appendInstruction(body, "createNumber", [], {
			attributes: { value: 3 },
		});
		const [sum] = builder.appendInstruction(
			body,
			"binary",
			[firstDuplicate!, secondDuplicate!],
			{ attributes: { operator: "+" } },
		);
		const [deadCopy] = builder.appendInstruction(body, "move", [carried]);
		builder.setTerminator(body, { kind: "return", value: carried });
		const complete = builder.finish(entry);
		const claimed = complete.blocks[entry]!.instructions.find(
			({ outputs }) => outputs[0] === certified,
		)!;
		const certifiedFunction: CoreFunction = {
			...complete,
			regions: [
				{
					kind: "test-certificate",
					anchors: [claimed.id],
					claimedInstructions: [claimed.id],
					ordinaryBlocks: [entry],
					exceptionalBlocks: [],
					data: { call: { $coreInstruction: claimed.id } },
				},
			],
		};

		const optimized = optimizeVerified(coreProgramOf([certifiedFunction])).program;
		const fn = optimized.functions[0]!;

		expect(fn.regions).toEqual(certifiedFunction.regions);
		expect(fn.blocks[entry]!.instructions.find(({ id }) => id === claimed.id)).toEqual(
			claimed,
		);
		expect(opcodesOf(fn)).not.toContain("move");
		expect(opcodesOf(fn)).not.toContain("createNumber");
		expect(opcodesOf(fn)).not.toContain("binary");
		for (const value of [firstDuplicate!, secondDuplicate!, sum!, deadCopy!]) {
			expect(definesValue(fn, value)).toBe(false);
		}
	});
});

interface GraphVariation {
	readonly join: boolean;
	readonly branch: "dynamic" | "constant";
	readonly loop: boolean;
	readonly deadProducer: boolean;
	readonly copy: boolean;
}

/**
 * Exhaustive small matrix rather than sampling, so the composition coverage is
 * fixed by construction. A constant branch condition only exists when there is a
 * join to fold, so those combinations are not enumerated.
 */
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
	readonly program: CoreProgram;
	readonly header?: CoreBlockId;
	readonly joinParameter?: CoreValueId;
	readonly deadValue?: CoreValueId;
}

function buildVariation(variation: GraphVariation): BuiltVariation {
	const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 1 });
	const entry = builder.createBlock([{ representation: "boxed" }]);
	const guardValue = builder.block(entry).parameters[0]!.value;
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
		carried = builder.block(header).parameters[0]!.value;
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
		joinParameter = builder.block(merge).parameters[0]!.value;
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
			edge: { block: header, arguments: [builder.block(latch).parameters[0]!.value] },
		});
		builder.setTerminator(exit, {
			kind: "return",
			value: builder.block(exit).parameters[0]!.value,
		});
	} else {
		builder.setTerminator(current, { kind: "return", value });
	}
	return {
		program: coreProgramOf([builder.finish(entry)]),
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
			const requiresCleanup =
				variation.deadProducer ||
				variation.copy ||
				(variation.join && variation.branch === "constant");

			const result = optimizeVerified(built.program);
			if (requiresCleanup) expect(result.changed).toBe(true);
			const fn = result.program.functions[0]!;

			expect(opcodesOf(fn)).not.toContain("move");
			if (built.deadValue !== undefined) {
				expect(definesValue(fn, built.deadValue)).toBe(false);
			}
			if (built.joinParameter !== undefined) {
				expect(
					fn.blocks.some(({ parameters }) =>
						parameters.some(({ value }) => value === built.joinParameter),
					),
				).toBe(variation.branch === "dynamic");
			}
			const cfg = buildCoreControlFlow(fn, coreOpcodeRegistry);
			if (built.header === undefined) {
				expect(cfg.loops).toHaveLength(0);
			} else {
				expect(cfg.loops).toHaveLength(1);
				expect(fn.blocks[cfg.loops[0]!.header]!.parameters).toHaveLength(1);
				expect(ordinaryPredecessorCount(fn, cfg.loops[0]!.header)).toBe(2);
			}
		});
	}
});
