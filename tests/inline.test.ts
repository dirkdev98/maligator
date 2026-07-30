import { expect, test } from "vitest";
import {
	findHofInlineSites,
	findInlinableCalls,
	findMethodInlineSites,
} from "../src/inline.ts";
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
	// splices its blocks + a join block and converts each return. Keep the input
	// dynamic so constant folding cannot remove the branch after inlining.
	const source = `globalThis.clamped = function (value) {
			function clamp(x, lo, hi){ if (x < lo) return lo; if (x > hi) return hi; return x; }
			return clamp(value, 0, 10);
		};`;
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

test("residual large immutable local calls retain their exact function index", () => {
	const body = Array.from({ length: 24 }, (_, index) => `value += ${index};`).join("\n");
	const ir = optimizedProgram(`
		const large = function large(value) { ${body} return value; };
		globalThis.result = large(1);
	`);
	const calls = ir.functions.flatMap((fn) =>
		fn.blocks.flatMap((block) =>
			block.instructions.filter((instruction) => instruction.type === "call"),
		),
	);
	expect(calls).toHaveLength(1);
	expect(calls[0]).toMatchObject({ directFunctionIndex: 1 });
});

test("residual dynamic globals and methods are not direct-call annotated", () => {
	const ir = optimizedProgram(`
		globalThis.dynamic = function (value) { return value; };
		globalThis.dynamic(1);
		const holder = { method(value) { return value; } };
		holder.method(2);
	`);
	const calls = ir.functions.flatMap((fn) =>
		fn.blocks.flatMap((block) =>
			block.instructions.filter((instruction) => instruction.type === "call"),
		),
	);
	expect(calls.length).toBeGreaterThanOrEqual(2);
	expect(calls.every((call) => call.directFunctionIndex === undefined)).toBe(true);
});

test("exact Function.prototype.call shapes retain target provenance", () => {
	const ir = optimizedProgram(`
		const exact = function exact(value) { "use strict"; return this === null ? value : 0; };
		exact.call(null, 1);
		const slice = Array.prototype.slice;
		slice.call([1, 2], 1);
		function dynamic(callback, value) { return callback.call(null, value); }
	`);
	const calls = ir.functions.flatMap((fn) =>
		fn.blocks.flatMap((block) =>
			block.instructions.filter((instruction) => instruction.type === "call"),
		),
	);
	const flattened = calls.filter((call) => call.directFunctionCall);
	expect(flattened).toHaveLength(2);
	expect(flattened.some((call) => call.directCallTargetFunctionIndex !== undefined)).toBe(
		true,
	);
	expect(
		calls.some(
			(call) =>
				!call.directFunctionCall && call.directCallTargetFunctionIndex === undefined,
		),
	).toBe(true);
});

test("own call overrides remain guarded candidates", () => {
	const ir = optimizedProgram(`
		const exact = function exact(value) { return value; };
		exact.call = function overridden() { return 2; };
		exact.call(null, 1);
	`);
	const flattened = ir.functions.flatMap((fn) =>
		fn.blocks.flatMap((block) =>
			block.instructions.filter(
				(instruction) => instruction.type === "call" && instruction.directFunctionCall,
			),
		),
	);
	expect(flattened).toHaveLength(1);
	expect(flattened[0]).toMatchObject({ directCallTargetFunctionIndex: 1 });
});

test("direct push sites carry guarded Array dispatch metadata", () => {
	const ir = optimizedProgram(`
		const dense = [];
		dense.push(1, 2);
		function possibleArray(value) { return value.push(3); }
		function streamProtocol(value) { return this.push(value); }
		const plain = { push() { return 4; } };
		plain.push();
	`);
	const calls = ir.functions.flatMap((fn) =>
		fn.blocks.flatMap((block) =>
			block.instructions.filter((instruction) => instruction.type === "call"),
		),
	);
	const marked = calls.filter((call) => call.directArrayPush);
	// The plain-object override remains a guarded candidate and must miss at runtime;
	// the bare-this stream protocol is the only statically excluded method shape.
	expect(marked).toHaveLength(3);
	expect(marked.some((call) => call.registers.length === 5)).toBe(true);
});

test("immutable ordinary script constructors retain their exact function index", () => {
	const ir = optimizedProgram(`
		const Exact = function Exact(value) { this.value = value; };
		globalThis.result = new Exact(1);
	`);
	const constructs = ir.functions.flatMap((fn) =>
		fn.blocks.flatMap((block) =>
			block.instructions.filter((instruction) => instruction.type === "construct"),
		),
	);
	expect(constructs).toHaveLength(1);
	expect(constructs[0]).toMatchObject({ directFunctionIndex: 1 });
});

test("immutable base and derived classes are exact constructor targets", () => {
	const ir = optimizedProgram(`
		class Base {}
		const Derived = class Derived extends Base {};
		new Base();
		new Derived();
	`);
	const constructs = ir.functions.flatMap((fn) =>
		fn.blocks.flatMap((block) =>
			block.instructions.filter((instruction) => instruction.type === "construct"),
		),
	);
	expect(constructs).toHaveLength(2);
	expect(
		constructs.every((construct) => construct.directFunctionIndex !== undefined),
	).toBe(true);
});

test("dynamic and non-constructible script values are not direct-constructor annotated", () => {
	const ir = optimizedProgram(`
		const arrow = () => 1;
		try { new arrow(); } catch {}
		globalThis.Dynamic = function Dynamic() {};
		new globalThis.Dynamic();
	`);
	const constructs = ir.functions.flatMap((fn) =>
		fn.blocks.flatMap((block) =>
			block.instructions.filter((instruction) => instruction.type === "construct"),
		),
	);
	expect(constructs).toHaveLength(2);
	expect(
		constructs.every((construct) => construct.directFunctionIndex === undefined),
	).toBe(true);
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

test("classified frame-argument reads become call-site values when inlined", () => {
	const fn = optimizedNested(
		`(function (){ function g(){ return arguments.length + arguments[1]; } return g(10, 20, 30); })();`,
	);
	expect(countType(fn, "call")).toBe(0);
	expect(countType(fn, "loadArgumentCount")).toBe(0);
	expect(countType(fn, "loadArgument")).toBe(0);
});

test("a missing static arguments index keeps the call fallback", () => {
	const fn = optimizedNested(
		`(function (){ function g(){ return arguments[1]; } return g(10); })();`,
	);
	expect(countType(fn, "call")).toBe(1);
});

test("methods that read classified frame arguments are guarded-inline candidates", () => {
	const source = `
		const obj = {
			count(){ return arguments.length; },
			first(){ return arguments[0]; },
		};
		obj.count(1, 2,);
		obj.first(42,);
	`;
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		source,
		"test.js",
		parseScript(source, { strict: true }),
	);
	const ir = compileSemanticProgramToIr(semantic);
	const instructionTypes = new Set(
		ir.functions.flatMap((fn) =>
			fn.blocks.flatMap((block) =>
				block.instructions.map((instruction) => instruction.type),
			),
		),
	);

	expect(instructionTypes).toContain("loadArgumentCount");
	expect(instructionTypes).toContain("loadArgument");
	expect([...findMethodInlineSites(ir).byCaller.values()].flat()).toHaveLength(2);
});

test("three-way polymorphic methods inline behind exact callee guards", () => {
	const source = `
		class A { quote(order) { return order.net + 7; } }
		class B { quote(order) { return order.net - Math.floor(order.net / 12); } }
		class C { quote(order) { return order.net + Math.max(15, order.qty * 3); } }
		const rules = [new A(), new B(), new C()];
		const order = { net: 100, qty: 2 };
		globalThis.result = rules[globalThis.index].quote(order);
	`;
	const ir = optimizedProgram(source);
	const instructions = ir.functions.flatMap((fn) =>
		fn.blocks.flatMap((block) => block.instructions),
	);
	expect(
		instructions.filter((instruction) => instruction.type === "guardFunctionIndex"),
	).toHaveLength(3);
	expect(
		instructions.filter((instruction) => instruction.type === "call").length,
	).toBeGreaterThan(0);
});

test("four same-name method bodies retain the original call", () => {
	const source = `
		class A { quote(value) { return value + 1; } }
		class B { quote(value) { return value + 2; } }
		class C { quote(value) { return value + 3; } }
		class D { quote(value) { return value + 4; } }
		const rules = [new A(), new B(), new C(), new D()];
		globalThis.result = rules[globalThis.index].quote(10);
	`;
	const ir = optimizedProgram(source);
	expect(
		ir.functions.flatMap((fn) =>
			fn.blocks.flatMap((block) =>
				block.instructions.filter(
					(instruction) => instruction.type === "guardFunctionIndex",
				),
			),
		),
	).toHaveLength(0);
});

test("a unique strict class method inlines behind a loaded-callee guard", () => {
	expect(
		programCountType(
			`class Calculator { compute(value) { return value + 1; } } globalThis.result = new Calculator().compute(2);`,
			"guardFunctionIndex",
		),
	).toBe(1);
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

// --- HOF callback inlining: eligibility analysis (detection only) ---

/** Detected HOF inline sites on the raw IR (detection works pre-optimization;
 * running the full pipeline would substitute forEach and consume the site). */
function hofSites(source: string) {
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		source,
		"test.js",
		parseScript(source, { strict: true }),
	);
	const ir = compileSemanticProgramToIr(semantic);
	return [...findHofInlineSites(ir).byCaller.values()].flat();
}

test("arr.forEach with an inlinable arrow callback is a HOF site", () => {
	const sites = hofSites(
		`(function (){ let s = 0; const a = [1,2,3]; a.forEach(x => { s += x; }); return s; })();`,
	);
	expect(sites.length).toBe(1);
	expect(sites[0]!.method).toBe("forEach");
});

test("arr.map / arr.filter with inlinable callbacks are HOF sites", () => {
	expect(
		hofSites(`(function (){ const a = [1,2]; return a.map(x => x * 2); })();`).map(
			(s) => s.method,
		),
	).toEqual(["map"]);
	expect(
		hofSites(
			`(function (){ function keep(x){ return x > 1; } const a = [1,2]; return a.filter(keep); })();`,
		).map((s) => s.method),
	).toEqual(["filter"]);
});

test("reduce IS a HOF callback site (the callback is still the first argument)", () => {
	const sites = hofSites(
		`(function (){ const a = [1,2]; return a.reduce((acc, x) => acc + x, 0); })();`,
	);
	expect(sites.map((s) => s.method)).toEqual(["reduce"]);
});

test("a HOF callback that uses `this` is not an inlinable site", () => {
	expect(
		hofSites(
			`(function (){ const a = [1,2]; a.forEach(function (x){ return this; }); })();`,
		),
	).toEqual([]);
});

test("a non-iteration method call (push) is not a HOF site", () => {
	expect(hofSites(`(function (){ const a = [1]; a.push(2); return a; })();`)).toEqual([]);
});

test("a HOF method called with a non-function first arg is not a site", () => {
	// `arr.includes(x)` shares the method-call shape but the arg is not a function.
	expect(hofSites(`(function (){ const a = [1,2]; return a.forEach(42); })();`)).toEqual(
		[],
	);
});

// --- HOF callback inlining: substitution (forEach) ---

/** Per-function instruction-type counts after optimization (program-wide). */
function programInstrCount(
	source: string,
	predicate: (i: { type: string }) => boolean,
): number {
	const ir = optimizedProgram(source);
	return ir.functions
		.flatMap((fn) => fn.blocks.flatMap((b) => b.instructions))
		.filter(predicate).length;
}

test("arr.forEach(arrow) is replaced by a guarded inlined loop", () => {
	const source = `(function (){ let s = 0; const a = [1,2,3]; a.forEach(x => { s += x; }); return s; })();`;
	// The guard helper is loaded, and the callback body (a binary add) is inlined
	// into the loop rather than dispatched.
	expect(
		programInstrCount(
			source,
			(i) =>
				i.type === "loadIntrinsic" &&
				(i as { intrinsic?: string }).intrinsic === "__arrayIterationEligible",
		),
	).toBeGreaterThan(0);
});

test("the forEach callback closure is sunk to the slow path (fast path allocates none)", () => {
	// After the fast-path callback is inlined, the original createFunction is dead and
	// DCE'd; a single createFunction remains, isolated on the slow (fallback) block.
	const source = `(function (){ let s = 0; const a = [1,2,3]; a.forEach(x => { s += x; }); return s; })();`;
	const ir = optimizedProgram(source);
	const owner = ir.functions.find((fn) =>
		fn.blocks.some((b) =>
			b.instructions.some(
				(i) =>
					i.type === "loadIntrinsic" &&
					(i as { intrinsic?: string }).intrinsic === "__arrayIterationEligible",
			),
		),
	)!;
	const blocksWithClosure = owner.blocks.filter((b) =>
		b.instructions.some((i) => i.type === "createFunction"),
	).length;
	expect(blocksWithClosure).toBe(1); // only the slow path creates the closure
});

test("the forEach fast path shadows an otherwise unobservable mutable capture", () => {
	const source = `(function (){ let s = 0; const a = [1,2,3]; a.forEach(x => { s += x; }); return s; })();`;
	const owner = optimizedNested(source);
	const capturedLoads = countType(owner, "loadCaptured");
	const capturedStores = countType(owner, "storeCaptured");
	// One load initializes the fast-path shadow and one reads the final result. The
	// two callback accesses themselves were rewritten to moves. Stores are the TDZ
	// initialization, source initialization, and one fast-path commit.
	expect(capturedLoads).toBe(2);
	expect(capturedStores).toBe(3);
});

test("capture shadowing stays disabled when another closure can observe the slot", () => {
	const source = `(function (){ let s = 0; globalThis.savedRead = () => s; const a = [1,2,3]; a.forEach(x => { s += x; }); return s; })();`;
	const owner = optimizedNested(source);
	// The callback's environment traffic remains together in its inlined loop block
	// because the escaped observer can run re-entrantly while iteration is active.
	expect(
		owner.blocks.some(
			(block) =>
				block.instructions.some((instruction) => instruction.type === "loadCaptured") &&
				block.instructions.some((instruction) => instruction.type === "storeCaptured"),
		),
	).toBe(true);
});

test("some/every/find/findIndex are each replaced by a guarded inlined loop", () => {
	for (const method of ["some", "every", "find", "findIndex"]) {
		const source = `(function (){ const a = [1,2,3]; return a.${method}(x => x > 1); })();`;
		const guards = programInstrCount(
			source,
			(i) =>
				i.type === "loadIntrinsic" &&
				(i as { intrinsic?: string }).intrinsic === "__arrayIterationEligible",
		);
		expect(guards, `${method} should be guard-inlined`).toBeGreaterThan(0);
	}
});

test("flatMap is replaced by a guarded inlined loop using the flatten-append helper", () => {
	const source = `(function (){ const a = [1,2,3]; return a.flatMap(x => [x, x]); })();`;
	expect(
		programInstrCount(
			source,
			(i) =>
				i.type === "loadIntrinsic" &&
				(i as { intrinsic?: string }).intrinsic === "__arrayIterationEligible",
		),
		"flatMap should be guard-inlined",
	).toBeGreaterThan(0);
	// The per-element spread goes through the __arrayFlatMapAppend intrinsic.
	expect(
		programInstrCount(
			source,
			(i) =>
				i.type === "loadIntrinsic" &&
				(i as { intrinsic?: string }).intrinsic === "__arrayFlatMapAppend",
		),
		"flatMap should load the flatten-append helper",
	).toBeGreaterThan(0);
});

test("the flatMap callback closure is sunk to the slow path", () => {
	const source = `(function (){ const a = [1,2,3]; return a.flatMap(x => [x, x]); })();`;
	const ir = optimizedProgram(source);
	const owner = ir.functions.find((fn) =>
		fn.blocks.some((b) =>
			b.instructions.some(
				(i) =>
					i.type === "loadIntrinsic" &&
					(i as { intrinsic?: string }).intrinsic === "__arrayIterationEligible",
			),
		),
	)!;
	const blocksWithClosure = owner.blocks.filter((b) =>
		b.instructions.some((i) => i.type === "createFunction"),
	).length;
	expect(blocksWithClosure).toBe(1); // only the slow path creates the closure
});

test("map/filter are now replaced by a guarded inlined loop", () => {
	for (const method of ["map", "filter"]) {
		const source = `(function (){ const a = [1,2,3]; return a.${method}(x => x * 2); })();`;
		const guards = programInstrCount(
			source,
			(i) =>
				i.type === "loadIntrinsic" &&
				(i as { intrinsic?: string }).intrinsic === "__arrayIterationEligible",
		);
		expect(guards, `${method} should be guard-inlined`).toBeGreaterThan(0);
	}
});

test("the map callback closure is sunk to the slow path", () => {
	const source = `(function (){ const a = [1,2,3]; return a.map(x => x * 2); })();`;
	const ir = optimizedProgram(source);
	const owner = ir.functions.find((fn) =>
		fn.blocks.some((b) =>
			b.instructions.some(
				(i) =>
					i.type === "loadIntrinsic" &&
					(i as { intrinsic?: string }).intrinsic === "__arrayIterationEligible",
			),
		),
	)!;
	const blocksWithClosure = owner.blocks.filter((b) =>
		b.instructions.some((i) => i.type === "createFunction"),
	).length;
	expect(blocksWithClosure).toBe(1); // only the slow path creates the closure
});

test("reduce(cb, init) is replaced by a guarded inlined loop; reduce(cb) is not", () => {
	const withInit = `(function (){ const a = [1,2,3]; return a.reduce((acc, x) => acc + x, 0); })();`;
	expect(
		programInstrCount(
			withInit,
			(i) =>
				i.type === "loadIntrinsic" &&
				(i as { intrinsic?: string }).intrinsic === "__arrayIterationEligible",
		),
	).toBeGreaterThan(0);
	// No initial value → not inlined (first-element/empty-throw stays on the slow path).
	const noInit = `(function (){ const a = [1,2,3]; return a.reduce((acc, x) => acc + x); })();`;
	expect(
		programInstrCount(
			noInit,
			(i) =>
				i.type === "loadIntrinsic" &&
				(i as { intrinsic?: string }).intrinsic === "__arrayIterationEligible",
		),
	).toBe(0);
});

test("backward HOF methods (reduceRight/findLast/findLastIndex) are guard-inlined", () => {
	const cases: Array<[string, string]> = [
		[
			"reduceRight",
			`(function (){ const a=[1,2,3]; return a.reduceRight((acc,x)=>acc+x, 0); })();`,
		],
		["findLast", `(function (){ const a=[1,2,3]; return a.findLast(x=>x<2); })();`],
		[
			"findLastIndex",
			`(function (){ const a=[1,2,3]; return a.findLastIndex(x=>x<2); })();`,
		],
	];
	for (const [name, source] of cases) {
		expect(
			programInstrCount(
				source,
				(i) =>
					i.type === "loadIntrinsic" &&
					(i as { intrinsic?: string }).intrinsic === "__arrayIterationEligible",
			),
			`${name} should be guard-inlined`,
		).toBeGreaterThan(0);
	}
});
