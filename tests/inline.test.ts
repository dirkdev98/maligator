import { expect, test } from "vitest";
import { findInlinableCalls } from "../src/inline.ts";
import { executeIROptimizations } from "../src/ir-opt.ts";
import { compileSemanticProgramToIr } from "../src/ir.ts";
import { parseScript } from "../src/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/semantic-analysis.ts";

/** Inlinable-call candidates for a source string, after IR optimization (the point
 * the inliner pass runs — so callee registers resolve through the move chain). */
function candidates(source: string) {
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		source,
		"test.js",
		parseScript(source, { strict: true }),
	);
	const ir = compileSemanticProgramToIr(semantic);
	executeIROptimizations(ir);
	return findInlinableCalls(ir).byCaller;
}

/** Candidate count for the single nested IIFE (function index 1). The inliner runs
 * inside `executeIROptimizations`, so this counts only candidates it did NOT consume
 * (ineligible targets) — used by the must-not-inline cases below. */
function nestedCount(source: string): number {
	return candidates(source).get(1)?.length ?? 0;
}

/** The nested IIFE function (index 1) after IR optimization (post-inlining). */
function optimizedNested(source: string) {
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		source,
		"test.js",
		parseScript(source, { strict: true }),
	);
	const ir = compileSemanticProgramToIr(semantic);
	executeIROptimizations(ir);
	return ir.functions.find((fn) => fn.functionIndex === 1)!;
}

function countType(fn: ReturnType<typeof optimizedNested>, type: string): number {
	return fn.blocks.flatMap((b) => b.instructions).filter((i) => i.type === type).length;
}

/** The whole IR program after optimization (for inspecting the shared position table). */
function optimizedProgram(source: string) {
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		source,
		"test.js",
		parseScript(source, { strict: true }),
	);
	const ir = compileSemanticProgramToIr(semantic);
	executeIROptimizations(ir);
	return ir;
}

test("direct calls to a small local closure are inlined and the closure eliminated", () => {
	// `f` is a non-capturing local arrow called twice; both calls inline and the
	// now-unused closure is dropped by DCE.
	const fn = optimizedNested(
		`(function (){ const f = (x) => x + 1; return f(2) + f(3); })();`,
	);
	expect(countType(fn, "call")).toBe(0);
	expect(countType(fn, "createFunction")).toBe(0);
});

test("a direct call to a local function declaration is inlined", () => {
	// The call is replaced by the inlined body (the closure may remain — function
	// declarations bind through the env via storeCaptured, which DCE keeps).
	const fn = optimizedNested(
		`(function (){ function g(x){ return x * 2; } return g(4); })();`,
	);
	expect(countType(fn, "call")).toBe(0);
});

/** Program-wide instruction-type count after optimization. */
function programCountType(source: string, type: string): number {
	const ir = optimizedProgram(source);
	return ir.functions
		.flatMap((fn) => fn.blocks.flatMap((b) => b.instructions))
		.filter((i) => i.type === type).length;
}

test("a branching, multi-return local function is inlined block-wise", () => {
	// `clamp` has three return points across multiple blocks; the multi-block path
	// splices its blocks + a join block and converts each return. Inlining cascades
	// (clamp into the IIFE, the IIFE into top level), so assert program-wide: the
	// direct calls disappear, and clamp's branching body (jumpIf) lands somewhere.
	const source = `(function (){
			function clamp(x, lo, hi){ if (x < lo) return lo; if (x > hi) return hi; return x; }
			return clamp(5, 0, 10) + clamp(-1, 0, 10);
		})();`;
	expect(programCountType(source, "call")).toBe(0);
	expect(programCountType(source, "jumpIf")).toBeGreaterThan(0);
});

test("a local function with a loop body inlines (back-edge preserved)", () => {
	// The loop's back-edge is a `jump` to an earlier block; multi-block inlining
	// must remap it by the block offset, not drop it.
	const source = `(function (){
			function sumTo(n){ let t = 0; for (let i = 1; i <= n; i++) t += i; return t; }
			return sumTo(5);
		})();`;
	expect(programCountType(source, "call")).toBe(0);
	expect(programCountType(source, "jumpIf")).toBeGreaterThan(0); // loop condition, spliced in
});

test("a call inside try is not multi-block inlined (handler-range soundness)", () => {
	// `boom` is a single-block `throw` target → the multi-block path. Inlining it
	// would append its throw after the function's tryEnd, escaping the handler. A
	// protected call must therefore be left alone; boom's call survives in the IIFE
	// (which itself is not inlinable: it has a try + a captured local function).
	const source = `(function (){
			function boom(){ throw 1; }
			let r = 0;
			try { boom(); } catch (e) { r = e; }
			return r;
		})();`;
	const fn = optimizedNested(source);
	expect(countType(fn, "call")).toBeGreaterThan(0);
	expect(countType(fn, "throw")).toBe(0); // boom's throw was NOT spliced in
});

test("a callee that uses `this` is not inlinable", () => {
	expect(
		nestedCount(`(function (){ function g(){ return this; } return g(); })();`),
	).toBe(0);
});

test("a callee that uses new.target is not inlinable", () => {
	expect(
		nestedCount(`(function (){ function g(){ return new.target; } return g(); })();`),
	).toBe(0);
});

test("a callee that materializes arguments is not inlinable", () => {
	expect(
		nestedCount(
			`(function (){ function g(){ return arguments.length; } return g(1); })();`,
		),
	).toBe(0);
});

test("a generator target is not inlinable", () => {
	expect(
		nestedCount(`(function (){ const g = function*(){ return 1; }; return g(); })();`),
	).toBe(0);
});

test("an unknown callee (a parameter) is not a candidate", () => {
	expect(nestedCount(`(function (cb){ return cb(1); })(x => x);`)).toBe(0);
});

test("construct (`new`) is not a call candidate", () => {
	expect(nestedCount(`(function (){ const C = function(){}; return new C(); })();`)).toBe(
		0,
	);
});

test("inlined instructions carry an inline source-position chain for stack traces", () => {
	// After `g` is inlined into the IIFE, its spliced source positions are
	// rewrapped (not stripped) so a captured stack still shows g's own frame
	// called at the call site — one logical frame per inline level.
	const ir = optimizedProgram(
		`(function (){ function g(x){ return x * 2; } return g(4); })();`,
	);
	// Inlining cascades (g into the IIFE, the IIFE into top level), so scan the
	// markers program-wide rather than assuming which physical function holds them.
	const inlineMarkers = ir.functions
		.flatMap((fn) => fn.blocks.flatMap((b) => b.instructions))
		.filter((i) => i.type === "sourcePos")
		.map((i) => ir.sourcePositions[(i as { pos: number }).pos]!)
		.filter((p) => p.inlinedFunctionIndex !== undefined);
	expect(inlineMarkers.length).toBeGreaterThan(0);
	for (const marker of inlineMarkers) {
		// Names a real function (g) and links to a caller position.
		expect(
			ir.functions.some((fn) => fn.functionIndex === marker.inlinedFunctionIndex),
		).toBe(true);
		expect(typeof marker.callerPosId).toBe("number");
		// The caller chain must terminate at a physical (leaf) position — code in
		// the host function, not another inlined level — so traces are well-formed.
		let posId = marker.callerPosId!;
		let guard = 0;
		while (
			ir.sourcePositions[posId]!.inlinedFunctionIndex !== undefined &&
			guard++ < 100
		) {
			posId = ir.sourcePositions[posId]!.callerPosId!;
		}
		expect(ir.sourcePositions[posId]!.inlinedFunctionIndex).toBeUndefined();
	}
});

test("a direct self-recursive call is excluded (caller === target)", () => {
	// The recursive call inside `f` has caller === target === f, so it is not a
	// candidate; the outer call to `f` may still be (recursion is bounded by the
	// substitution's expansion depth, not eligibility).
	const byCaller = candidates(
		`(function (){ const f = (n) => n <= 0 ? 0 : f(n - 1); return f(5); })();`,
	);
	// fn#2 is `f`; its self-call must not be a candidate.
	expect(byCaller.get(2) ?? []).toEqual([]);
});
