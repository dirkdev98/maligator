import type { ESTree } from "meriyah";
import { expect, test } from "vitest";
import { parseScript } from "../src/parser.ts";
import {
	analyzeSourceAndRunSemanticAnalysis,
	functionHasDirectEval,
} from "../src/semantic-analysis.ts";

/** Analyze a script and return its single SemanticFile. */
function analyze(source: string, strict = true) {
	const program = analyzeSourceAndRunSemanticAnalysis(
		source,
		"test.js",
		parseScript(source, { strict }),
	);
	return program.files[0]!;
}

/** First function-defining node of the given type, depth-first. */
function findNode(node: ESTree.Node, type: string): ESTree.Node | undefined {
	if (node.type === type) {
		return node;
	}
	for (const key of Object.keys(node)) {
		const value = (node as unknown as Record<string, unknown>)[key];
		const children = Array.isArray(value) ? value : [value];
		for (const child of children) {
			if (child && typeof child === "object" && "type" in child) {
				const found = findNode(child as ESTree.Node, type);
				if (found) {
					return found;
				}
			}
		}
	}
	return undefined;
}

test("direct eval poisons the enclosing function and the Program", () => {
	const file = analyze(`
		function f() {
			let x = 1;
			eval("x");
		}
	`);
	const fn = findNode(file.ast, "FunctionDeclaration")!;
	expect(functionHasDirectEval(file, fn)).toBe(true);
	expect(functionHasDirectEval(file, file.ast)).toBe(true);
});

test("a nested direct eval poisons the outer function too", () => {
	const file = analyze(`
		function outer() {
			let x = {};
			function inner() {
				eval("x.leak = 1");
			}
			inner();
		}
	`);
	const outer = findNode(file.ast, "FunctionDeclaration")!;
	expect(outer.type).toBe("FunctionDeclaration");
	// outer is the first FunctionDeclaration found depth-first.
	expect(functionHasDirectEval(file, outer)).toBe(true);
});

test("indirect eval does NOT poison", () => {
	const file = analyze(`
		function f() {
			let x = 1;
			(0, eval)("x");
			globalThis.eval("x");
		}
	`);
	const fn = findNode(file.ast, "FunctionDeclaration")!;
	expect(functionHasDirectEval(file, fn)).toBe(false);
	expect(functionHasDirectEval(file, file.ast)).toBe(false);
});

test("a shadowing local `eval` is not direct eval", () => {
	const file = analyze(
		`
		function f() {
			let x = 1;
			var eval = function (s) { return s; };
			eval("x");
		}
	`,
		false,
	);
	const fn = findNode(file.ast, "FunctionDeclaration")!;
	expect(functionHasDirectEval(file, fn)).toBe(false);
});

test("a sibling's eval does not poison an unrelated function", () => {
	const file = analyze(`
		function a() { let y = 1; return y; }
		function b() { eval("z"); }
	`);
	const a = findNode(file.ast, "FunctionDeclaration")!;
	// `a` is found first depth-first; it must stay clean.
	expect(functionHasDirectEval(file, a)).toBe(false);
	// Program is still poisoned (b's eval is at top level lexically).
	expect(functionHasDirectEval(file, file.ast)).toBe(true);
});

test("no eval anywhere leaves the set empty", () => {
	const file = analyze(`function f() { let x = 1; return x; }`);
	expect(file.hasDirectEval.size).toBe(0);
});

test("direct eval is a conservative use of lexical arguments through an arrow", () => {
	const file = analyze(`
		function outer() {
			return () => eval("arguments.length");
		}
	`);
	const evalCall = findNode(file.ast, "CallExpression")!;
	const binding = file.nodeToBinding.get(evalCall);
	expect(binding?.implicit).toBe("arguments");
	expect(binding?.scopedTo).toBe("captured");
	expect(binding?.usageNodes).toContain(evalCall);
});
