import { expect, test } from "vitest";
import { compileSemanticProgramToIr } from "../src/ir.ts";
import type { IRFunction } from "../src/ir.ts";
import {
	computeFunctionLiveness,
	computeProgramLiveness,
	computeSafepointRoots,
	estimateLivenessComplexity,
	findBackEdges,
	isSafepoint,
} from "../src/liveness.ts";
import { parseScript } from "../src/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/semantic-analysis.ts";

/** Build the IR program (pre-register-allocation) for a source string. */
function buildIr(source: string) {
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		source,
		"test.js",
		parseScript(source, { strict: true }),
	);
	return compileSemanticProgramToIr(semantic);
}

/** The top-level entry function (function index 0). */
function entryFunction(source: string): IRFunction {
	return buildIr(source).functions.find((fn) => fn.functionIndex === 0)!;
}

/** All instructions of a function, flattened in block order. */
function instructionsOf(fn: IRFunction) {
	return fn.blocks.flatMap((block) => block.instructions);
}

/**
 * A minimal fake IRFunction built from raw instruction arrays. The liveness pass
 * only reads `fn.blocks`, so this lets us assert the dataflow on hand-crafted CFGs
 * (loops, exception edges) without fighting the IR generator's slot choices.
 */
function fakeFn(
	blocks: Array<Array<unknown>>,
	nextRegisterDestination?: number,
): IRFunction {
	return {
		blocks: blocks.map((instructions) => ({ instructions })),
		nextRegisterDestination,
	} as unknown as IRFunction;
}

test("isSafepoint: allocations and calls are safepoints, scalar/moves are not", () => {
	expect(isSafepoint({ type: "createObject", registers: [0] } as never)).toBe(true);
	expect(isSafepoint({ type: "call", registers: [0, 1] } as never)).toBe(true);
	expect(isSafepoint({ type: "loadProperty", registers: [0, 1, 2] } as never)).toBe(true);
	expect(isSafepoint({ type: "loadThis", registers: [0] } as never)).toBe(true);
	expect(isSafepoint({ type: "createNumber", registers: [0], value: 1 } as never)).toBe(
		false,
	);
	expect(isSafepoint({ type: "move", registers: [0, 1] } as never)).toBe(false);
	expect(
		isSafepoint({
			type: "typeofCompare",
			registers: [0, 1],
			expected: "object",
			negated: false,
		} as never),
	).toBe(false);
	expect(isSafepoint({ type: "jump", blocks: [0] } as never)).toBe(false);
	expect(isSafepoint({ type: "loadLocal", registers: [0, 1] } as never)).toBe(false);
	// Construction and suspension are collection points too.
	expect(isSafepoint({ type: "construct", registers: [0, 1] } as never)).toBe(true);
	expect(isSafepoint({ type: "await", registers: [0, 1] } as never)).toBe(true);
	expect(isSafepoint({ type: "yield", registers: [0, 1] } as never)).toBe(true);
});

test("a loop produces a back-edge to a header block", () => {
	const fn = entryFunction(`
		let total = 0;
		for (let i = 0; i < n; i++) {
			total = total + i;
		}
	`);
	const { backEdges, headerBlocks } = findBackEdges(fn);
	expect(backEdges.length).toBeGreaterThan(0);
	for (const edge of backEdges) {
		// A back-edge jumps to an index <= the block it lives in.
		expect(edge.to).toBeLessThanOrEqual(edge.from);
		expect(headerBlocks.has(edge.to)).toBe(true);
	}
});

test("straight-line code has no back-edges", () => {
	const fn = entryFunction(`let a = 1; let b = 2; a + b;`);
	expect(findBackEdges(fn).backEdges).toHaveLength(0);
});

test("a temporary spanning a call is live across that call's safepoint", () => {
	// `a()`'s result is a register temporary held while `b()` runs (a safepoint),
	// then consumed by the `+`. It must be reported live-across-safepoint.
	const fn = buildIr(`(function (a, b) { return a() + b(); })(x, y);`).functions.find(
		(candidate) => candidate.functionIndex === 1,
	)!;
	const calls = instructionsOf(fn).filter((instruction) => instruction.type === "call");
	expect(calls.length).toBe(2);
	const firstCallResult = (calls[0] as { registers: Array<number> }).registers[0]!;

	const liveness = computeFunctionLiveness(fn);
	expect(liveness.liveAcrossSafepoint.has(firstCallResult)).toBe(true);
});

test("a value living in a frame-local slot is NOT held in a register across the call", () => {
	// `keep` is a named local: the IR holds it in a local slot (storeLocal /
	// loadLocal), which is already a frame root scanned by the GC. So no register
	// temporary spans the `g()` call — its safepoint live set is empty. This is the
	// liveness minimization the GC design requires. (Registers
	// produced by OTHER safepoints and consumed downstream — e.g. the reloaded
	// `keep` before `return` — are still rooted at those safepoints under the
	// def-when-live-out rule, so we assert the call site itself, not the whole set.)
	const fn = buildIr(
		`(function f(g) { let keep = {}; g(); return keep; })(h);`,
	).functions.find((candidate) => candidate.functionIndex === 1)!;

	const liveness = computeFunctionLiveness(fn);
	const callSafepoint = liveness.safepoints.find(
		(sp) => fn.blocks[sp.blockIndex]!.instructions[sp.instructionIndex]!.type === "call",
	);
	expect(callSafepoint).toBeDefined();
	expect(callSafepoint!.live.size).toBe(0);
});

test("computeProgramLiveness covers every function", () => {
	const program = buildIr(`(function (a, b) { return a() + b(); })(x, y);`);
	const liveness = computeProgramLiveness(program);
	expect(liveness.byFunction.size).toBe(program.functions.length);
	for (const fn of program.functions) {
		expect(liveness.byFunction.has(fn.functionIndex)).toBe(true);
	}
});

test("a register carried across an allocation-free loop is live at the back-edge poll", () => {
	// b0: r5 = {} ; -> b1
	// b1: r6 = r5 ; r7 = true ; if (r7) -> b1 (back-edge)   [no allocation in body]
	// b2: return r6
	// r5 is read every iteration but the loop body never allocates, so ONLY the
	// back-edge poll keeps r5 live across a safepoint.
	const fn = fakeFn([
		[
			{ type: "createObject", registers: [5] },
			{ type: "jump", blocks: [1] },
		],
		[
			{ type: "move", registers: [6, 5] },
			{ type: "createBoolean", registers: [7], value: true },
			{ type: "jumpIf", registers: [7], blocks: [1] },
		],
		[{ type: "return", registers: [6] }],
	]);
	const liveness = computeFunctionLiveness(fn);

	expect(liveness.liveAcrossSafepoint.has(5)).toBe(true);
	const loopPolls = liveness.safepoints.filter((sp) => sp.kind === "loop-poll");
	expect(loopPolls.length).toBe(1);
	expect(loopPolls[0]!.live.has(5)).toBe(true);
});

test("exception edges keep a try-body value live for the handler (soundness)", () => {
	// b0: r5 = {} ; tryBegin[handler=2, end=3] ; -> b1
	// b1: r6 = g ; r7 = undefined ; r8 = call(r6, r7) ; tryEnd ; -> b3   [r5 unused here]
	// b2 (handler): r9 = catch ; r10 = r9 + r5 ; -> b3                   [r5 used ONLY here]
	// b3: r11 = undefined ; return r11
	// r5 is dead on the normal path but read in the handler, so the call (which may
	// throw to the handler) must keep r5 live — proving the exception edge is modeled.
	const fn = fakeFn([
		[
			{ type: "createObject", registers: [5] },
			{ type: "tryBegin", blocks: [2, 3] },
			{ type: "jump", blocks: [1] },
		],
		[
			{ type: "loadUndeclared", registers: [6] },
			{ type: "createUndefined", registers: [7] },
			{ type: "call", registers: [8, 6, 7] },
			{ type: "tryEnd" },
			{ type: "jump", blocks: [3] },
		],
		[
			{ type: "catch", registers: [9] },
			{ type: "binary", registers: [10, 9, 5], operator: "+" },
			{ type: "jump", blocks: [3] },
		],
		[
			{ type: "createUndefined", registers: [11] },
			{ type: "return", registers: [11] },
		],
	]);
	const liveness = computeFunctionLiveness(fn);

	expect(liveness.liveAcrossSafepoint.has(5)).toBe(true);
	// The call is recorded as an alloc-call safepoint with r5 in its live set.
	const callSafepoint = liveness.safepoints.find(
		(sp) => sp.kind === "alloc-call" && sp.blockIndex === 1,
	);
	expect(callSafepoint).toBeDefined();
	expect(callSafepoint!.live.has(5)).toBe(true);
});

test("exception ranges use only the handler target and respect same-block markers", () => {
	// r5 is defined after the first safepoint, used only by the handler, and dead
	// after tryEnd. Only the safepoint between the markers may therefore contain it.
	// r12 is used only in blocks[1], the try-end retention target, which is never an
	// exceptional successor.
	const fn = fakeFn([
		[
			{ type: "createObject", registers: [0] },
			{ type: "createNumber", registers: [5], value: 1 },
			{ type: "tryBegin", blocks: [1, 2] },
			{ type: "createObject", registers: [6] },
			{ type: "tryEnd" },
			{ type: "createObject", registers: [7] },
			{ type: "createUndefined", registers: [8] },
			{ type: "return", registers: [8] },
		],
		[
			{ type: "catch", registers: [9] },
			{ type: "binary", registers: [10, 9, 5], operator: "+" },
			{ type: "return", registers: [10] },
		],
		[
			{ type: "move", registers: [13, 12] },
			{ type: "return", registers: [13] },
		],
	]);
	const liveness = computeFunctionLiveness(fn);
	const at = (instructionIndex: number) =>
		liveness.safepoints.find(
			(safepoint) =>
				safepoint.blockIndex === 0 && safepoint.instructionIndex === instructionIndex,
		)!.live;

	expect(at(0).has(5)).toBe(false);
	expect(at(3).has(5)).toBe(true);
	expect(at(5).has(5)).toBe(false);
	expect(at(3).has(12)).toBe(false);
});

test("nested ranges select the innermost handler and restore the outer handler", () => {
	const fn = fakeFn([
		[
			{ type: "tryBegin", blocks: [2, 3] },
			{ type: "createNumber", registers: [10], value: 10 },
			{ type: "tryBegin", blocks: [1, 4] },
			{ type: "createObject", registers: [0] },
			{ type: "tryEnd" },
			{ type: "createNumber", registers: [11], value: 11 },
			{ type: "createObject", registers: [1] },
			{ type: "tryEnd" },
			{ type: "createUndefined", registers: [2] },
			{ type: "return", registers: [2] },
		],
		[
			{ type: "catch", registers: [3] },
			{ type: "binary", registers: [4, 3, 10], operator: "+" },
			{ type: "return", registers: [4] },
		],
		[
			{ type: "catch", registers: [5] },
			{ type: "binary", registers: [6, 5, 11], operator: "+" },
			{ type: "return", registers: [6] },
		],
		[{ type: "return", registers: [2] }],
		[{ type: "return", registers: [2] }],
	]);
	const liveness = computeFunctionLiveness(fn);
	const inner = liveness.safepoints.find(
		(safepoint) => safepoint.blockIndex === 0 && safepoint.instructionIndex === 3,
	)!.live;
	const outer = liveness.safepoints.find(
		(safepoint) => safepoint.blockIndex === 0 && safepoint.instructionIndex === 6,
	)!.live;

	expect(inner.has(10)).toBe(true);
	expect(inner.has(11)).toBe(false);
	expect(outer.has(10)).toBe(false);
	expect(outer.has(11)).toBe(true);
});

test("an IteratorClose handler keeps the iterator live in its protected range", () => {
	const fn = fakeFn([
		[
			{ type: "createObject", registers: [5] },
			{ type: "tryBegin", blocks: [1, 2] },
			{ type: "call", registers: [8, 6, 7] },
			{ type: "tryEnd" },
			{ type: "return", registers: [8] },
		],
		[
			{ type: "catch", registers: [9] },
			{ type: "iteratorClose", registers: [5] },
			{ type: "throw", registers: [9] },
		],
		[{ type: "return", registers: [8] }],
	]);
	const liveness = computeFunctionLiveness(fn);
	const protectedCall = liveness.safepoints.find(
		(safepoint) => safepoint.blockIndex === 0 && safepoint.instructionIndex === 2,
	);

	expect(protectedCall!.live.has(5)).toBe(true);
});

test("source-only safepoints root every operand", () => {
	for (const [type, registers] of [
		["storeGlobalProperty", [5]],
		["mergeDataProperties", [5, 6]],
		["defineAccessor", [5, 6, 7]],
		["defineProperty", [5, 6, 7]],
		["definePrivate", [5, 6, 7]],
		["initPrivateFields", [5, 6, 7, 9]],
		["storePrivate", [5, 6, 7]],
		["iteratorClose", [5]],
		["withEnter", [5]],
		["checkSuperClass", [5]],
	] as const) {
		const roots = computeSafepointRoots(
			fakeFn([
				[
					{ type, registers: [...registers] },
					{ type: "createUndefined", registers: [8] },
					{ type: "return", registers: [8] },
				],
			]),
		);
		for (const register of registers) {
			expect(roots.registers.has(register), `${type} must root r${register}`).toBe(true);
		}
	}
});

test("storeLocal propagates its source through earlier safepoints", () => {
	const roots = computeSafepointRoots(
		fakeFn([
			[
				{ type: "createObject", registers: [5] },
				{ type: "storeLocal", registers: [5], index: 0 },
				{ type: "createUndefined", registers: [6] },
				{ type: "return", registers: [6] },
			],
		]),
	);

	expect(roots.registers.has(5)).toBe(true);
});

test("loadThis can throw to a handler and roots handler-live values", () => {
	const fn = fakeFn([
		[
			{ type: "createObject", registers: [5] },
			{ type: "tryBegin", blocks: [1, 2] },
			{ type: "loadThis", registers: [6] },
			{ type: "tryEnd" },
			{ type: "return", registers: [6] },
		],
		[
			{ type: "catch", registers: [7] },
			{ type: "binary", registers: [8, 7, 5], operator: "+" },
			{ type: "return", registers: [8] },
		],
		[{ type: "return", registers: [6] }],
	]);
	const liveness = computeFunctionLiveness(fn);
	const loadThis = liveness.safepoints.find(
		(safepoint) => safepoint.blockIndex === 0 && safepoint.instructionIndex === 2,
	);

	expect(loadThis).toBeDefined();
	expect(loadThis!.live.has(5)).toBe(true);
});

test("aggregate safepoint roots equal detailed roots for structured exceptions", () => {
	for (const source of [
		`try { try { f(); } catch (e) { g(e); } } finally { h(); }`,
		`for (const [value] of values) { consume(value); }`,
	]) {
		for (const fn of buildIr(source).functions) {
			const detailed = computeFunctionLiveness(fn);
			const aggregate = computeSafepointRoots(fn);
			expect(aggregate.usedFallback).toBe(false);
			expect([...aggregate.registers].sort()).toEqual(
				[...detailed.liveOrUsedAtSafepoint].sort(),
			);
		}
	}
});

test("complexity fallback reports itself and roots every physical register", () => {
	const fn = fakeFn(
		[
			[
				{ type: "tryBegin", blocks: [1, 0] },
				{ type: "createObject", registers: [0] },
				{ type: "tryEnd" },
				{ type: "return", registers: [0] },
			],
			[
				{ type: "catch", registers: [1] },
				{ type: "return", registers: [1] },
			],
		],
		4,
	);
	const roots = computeSafepointRoots(fn, { complexityLimit: 7 });

	expect(roots.complexityEstimate).toBe(8);
	expect(roots.usedFallback).toBe(true);
	expect([...roots.registers]).toEqual([0, 1, 2, 3]);
});

test("complexity estimation detects unsafe multiplication", () => {
	const fn = fakeFn(
		[
			[{ type: "tryBegin", blocks: [1, 0] }, { type: "tryEnd" }],
			[{ type: "return", registers: [0] }],
		],
		Number.MAX_SAFE_INTEGER,
	);
	expect(estimateLivenessComplexity(fn)).toBeNull();
});

test("safepoints list: union of per-safepoint live sets equals liveAcrossSafepoint", () => {
	const fn = buildIr(`(function (a, b) { return a() + b(); })(x, y);`).functions.find(
		(candidate) => candidate.functionIndex === 1,
	)!;
	const liveness = computeFunctionLiveness(fn);

	expect(liveness.safepoints.length).toBeGreaterThan(0);
	expect(liveness.safepoints.some((sp) => sp.kind === "alloc-call")).toBe(true);

	const union = new Set<number>();
	for (const sp of liveness.safepoints) {
		for (const register of sp.live) {
			union.add(register);
		}
	}
	expect([...union].sort()).toEqual([...liveness.liveAcrossSafepoint].sort());
});

test("liveOrUsedAtSafepoint adds a safepoint's operands that are dead immediately after", () => {
	// b0: r5 = loadLocal ; r6 = undefined ; r7 = call(r5, r6) ; r8 = undefined ; return r8
	// r5 (callee) and r6 (arg) are produced by non-safepoint ops and never read after
	// the call, so liveAcrossSafepoint (live-OUT, plus any safepoint's own live-out
	// def) omits them. They are still handed to the callee (which can collect before
	// re-rooting them), so liveOrUsedAtSafepoint — the set emit-c spills into the GC
	// root frame — must include them. This preserves the invariant that a caller keeps
	// an in-flight call's receiver/args reachable for the callee's `this`/args.
	const fn = fakeFn([
		[
			{ type: "loadLocal", registers: [5] },
			{ type: "createUndefined", registers: [6] },
			{ type: "call", registers: [7, 5, 6] },
			{ type: "createUndefined", registers: [8] },
			{ type: "return", registers: [8] },
		],
	]);
	const liveness = computeFunctionLiveness(fn);

	expect(liveness.liveAcrossSafepoint.has(5)).toBe(false);
	expect(liveness.liveAcrossSafepoint.has(6)).toBe(false);
	expect(liveness.liveOrUsedAtSafepoint.has(5)).toBe(true);
	expect(liveness.liveOrUsedAtSafepoint.has(6)).toBe(true);
});

test("liveOrUsedAtSafepoint is always a superset of liveAcrossSafepoint", () => {
	for (const source of [
		`(function (a, b) { return a() + b(); })(x, y);`,
		`(function f(g) { let keep = {}; g(); return keep.v; })(h);`,
		`(function (o) { for (let i = 0; i < 3; i++) o.f(i); })(p);`,
	]) {
		const program = buildIr(source);
		for (const fn of program.functions) {
			const { liveAcrossSafepoint, liveOrUsedAtSafepoint } = computeFunctionLiveness(fn);
			for (const register of liveAcrossSafepoint) {
				expect(liveOrUsedAtSafepoint.has(register)).toBe(true);
			}
		}
	}
});
