import { expect, test } from "vitest";
import { compileSemanticProgramToIr } from "../src/ir.ts";
import type { IRFunction } from "../src/ir.ts";
import { executeIROptimizations } from "../src/ir-opt.ts";
import { parseScript } from "../src/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/semantic-analysis.ts";

/** Optimized IR for a source string. */
function optimizedIr(source: string) {
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		source,
		"test.js",
		parseScript(source, { strict: true }),
	);
	const ir = compileSemanticProgramToIr(semantic);
	executeIROptimizations(ir);
	return ir;
}

/** Count instructions of a given type in a function. */
function countOp(fn: IRFunction, type: string): number {
	return fn.blocks.flatMap((b) => b.instructions).filter((i) => i.type === type).length;
}

// Function bodies compile lazily, so each function under test is written as an
// IIFE to force compilation; it is then function index 1.
function nested(source: string): IRFunction {
	return optimizedIr(source).functions.find((fn) => fn.functionIndex === 1)!;
}

test("a record read only by static own keys is scalar-replaced (allocation removed)", () => {
	const fn = nested(`(function (a){ const p = { x: a, y: a + 1 }; return p.x + p.y; })(0);`);
	expect(countOp(fn, "createObjectShaped")).toBe(0);
	// The keys' string constants are dead once the reads become moves.
	expect(countOp(fn, "loadProperty")).toBe(0);
});

test("a partially-read record is still removed (unread values fall to DCE)", () => {
	const fn = nested(`(function (a){ const p = { a: a, b: a * 2, c: a * 3 }; return p.b; })(0);`);
	expect(countOp(fn, "createObjectShaped")).toBe(0);
});

test("a per-iteration loop record is removed (snapshot handles the loop variable)", () => {
	const fn = nested(
		`(function (n){ let s = 0; for (let i = 0; i < n; i++) { const p = { v: i, w: i + 1 }; s += p.v + p.w; } return s; })(0);`,
	);
	expect(countOp(fn, "createObjectShaped")).toBe(0);
});

test("a record that escapes via return is NOT replaced", () => {
	const fn = nested(`(function (a){ const p = { x: a }; return p; })(0);`);
	expect(countOp(fn, "createObjectShaped")).toBe(1);
});

test("a record passed to a call is NOT replaced", () => {
	const fn = nested(`(function (a){ const p = { x: a }; return g(p); })(0);`);
	expect(countOp(fn, "createObjectShaped")).toBe(1);
});

test("a prototype read (key not on the record) keeps the allocation", () => {
	// `p.toString` resolves up the prototype chain, so the object must remain.
	const fn = nested(`(function (){ const p = { x: 1 }; return typeof p.toString; })();`);
	expect(countOp(fn, "createObjectShaped")).toBe(1);
});

test("a computed (non-constant) key read keeps the allocation", () => {
	const fn = nested(`(function (k){ const p = { x: 1, y: 2 }; return p[k]; })(0);`);
	expect(countOp(fn, "createObjectShaped")).toBe(1);
});

test("a mutated record keeps the allocation", () => {
	const fn = nested(`(function (){ const p = { x: 1 }; p.x = 9; return p.x; })();`);
	expect(countOp(fn, "createObjectShaped")).toBe(1);
});

test("the pass is disabled in a file containing a direct eval (C3)", () => {
	// hasDirectEval is file-scoped, so the eval in `g` disables the pass for `f` too.
	const fn = nested(
		`(function (a){ const p = { x: a }; return p.x; })(0); (function (s){ return eval(s); })("1");`,
	);
	expect(countOp(fn, "createObjectShaped")).toBe(1);
});

test("the pass is disabled for a generator body (C5)", () => {
	const fn = nested(`(function* (a){ const p = { x: a }; yield p.x; })(0);`);
	expect(countOp(fn, "createObjectShaped")).toBe(1);
});

test("a record read in a different block is scalar-replaced (cross-block alias)", () => {
	// `p` is stored to a local and read in two branches — reachable only through a
	// move, which the move-alias closure follows.
	const fn = nested(`(function (a, c){ const p = { x: a, y: a + 1 }; if (c) return p.x; return p.y; })(0, true);`);
	expect(countOp(fn, "createObjectShaped")).toBe(0);
});

test("a record copied to another local then read is scalar-replaced", () => {
	const fn = nested(`(function (a){ const p = { x: a }; const q = p; return q.x; })(0);`);
	expect(countOp(fn, "createObjectShaped")).toBe(0);
});

test("a record escaping through an alias copy is NOT replaced", () => {
	const fn = nested(`(function (a){ const p = { x: a }; const q = p; return q; })(0);`);
	expect(countOp(fn, "createObjectShaped")).toBe(1);
});

test("a record whose alias is reassigned is NOT replaced", () => {
	// `q` is not single-assignment, so the closure cannot prove it always holds p.
	const fn = nested(`(function (a, c){ const p = { x: a }; let q = p; if (c) q = { x: 9 }; return q.x; })(0, true);`);
	expect(countOp(fn, "createObjectShaped")).toBe(2);
});
