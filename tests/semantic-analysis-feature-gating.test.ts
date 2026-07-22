import { expect, test } from "vitest";
import { traverseEstree } from "../src/estree-traversal.ts";
import { parseScript } from "../src/parser.ts";
import {
	analyzeSourceAndRunSemanticAnalysis,
	functionHasDirectEval,
	semanticAnalysisTestHooks,
} from "../src/semantic-analysis.ts";

function analyze(source: string, strict = true) {
	return analyzeSourceAndRunSemanticAnalysis(
		source,
		"semantic-gating-test.js",
		parseScript(source, { strict }),
	).files[0]!;
}

function compilerCorpus(): string {
	return Array.from(
		{ length: 800 },
		(_, index) =>
			`function compilerBench${index}(a, b) {
	const folded = ((${index} + 17) * 9 - 11) / 2;
	const selected = (${index} & 1) === 0 ? folded + 3 : folded - 5;
	if ((${index} % 5) === 3) return a + selected;
	return b + selected;
}`,
	).join("\n");
}

test("compiler corpus skips sparse semantic-analysis passes", () => {
	semanticAnalysisTestHooks.resetWorkCounts();
	const file = analyze(compilerCorpus());
	let astNodes = 0;
	traverseEstree(file.ast, () => {
		astNodes++;
	});

	expect(astNodes).toBe(36_801);
	expect(file.hasDirectEval.size).toBe(0);
	expect(file.staticArgumentsAccesses.size).toBe(0);
	expect(semanticAnalysisTestHooks.workCounts()).toEqual({
		directEvalCandidates: 0,
		staticArgumentsTraversals: 0,
	});
});

test("resolved direct eval candidates are processed without an AST walk", () => {
	semanticAnalysisTestHooks.resetWorkCounts();
	const file = analyze(`
		function staticFirst() { return arguments.length; }
		function outer() { return () => eval("arguments.length"); }
	`);

	expect(functionHasDirectEval(file, file.ast)).toBe(true);
	expect(file.staticArgumentsAccesses.size).toBe(1);
	expect(semanticAnalysisTestHooks.workCounts()).toEqual({
		directEvalCandidates: 1,
		staticArgumentsTraversals: 1,
	});
});

test("static arguments candidates still classify across function forms", () => {
	semanticAnalysisTestHooks.resetWorkCounts();
	const file = analyze(`
		function normal() { return arguments.length; }
		function withDefault(value = arguments[0]) { return value; }
		function* generator() { yield arguments[1]; }
		async function asyncFunction() { return arguments[2]; }
	`);

	expect(file.staticArgumentsAccesses.size).toBe(4);
	expect(semanticAnalysisTestHooks.workCounts()).toEqual({
		directEvalCandidates: 0,
		staticArgumentsTraversals: 1,
	});
});

test("indirect eval and explicit arguments bindings stay outside candidate passes", () => {
	semanticAnalysisTestHooks.resetWorkCounts();
	const file = analyze(
		`function f(arguments) {
			eval?.("x");
			globalThis.eval("x");
			return arguments.length;
		}`,
		false,
	);

	expect(file.hasDirectEval.size).toBe(0);
	expect(file.staticArgumentsAccesses.size).toBe(0);
	expect(semanticAnalysisTestHooks.workCounts()).toEqual({
		directEvalCandidates: 0,
		staticArgumentsTraversals: 0,
	});
});

test("non-static implicit arguments uses conservatively retain classification", () => {
	semanticAnalysisTestHooks.resetWorkCounts();
	const file = analyze(
		`function arrowCapture() { return () => arguments.length; }
		 function escape() { return arguments; }
		 function dynamic() { with ({}) { return arguments[0]; } }`,
		false,
	);

	expect(file.staticArgumentsAccesses.size).toBe(0);
	expect(semanticAnalysisTestHooks.workCounts()).toEqual({
		directEvalCandidates: 0,
		staticArgumentsTraversals: 1,
	});
});
