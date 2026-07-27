import type { ESTree } from "meriyah";
import { expect, test } from "vitest";
import { compileSourceToBuffer } from "../src/compile.ts";
import type { DirectEvalContext } from "../src/direct-eval-context.ts";
import {
	decodeDirectEvalContext,
	encodeDirectEvalContext,
} from "../src/direct-eval-context.ts";
import { compileSemanticProgramToIr } from "../src/ir.ts";
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

function generatedDirectEvalContext(source: string): DirectEvalContext {
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		source,
		"test.js",
		parseScript(source, { strict: false }),
	);
	const program = compileSemanticProgramToIr(semantic);
	const instructions = program.functions.flatMap((fn) =>
		fn.blocks.flatMap((block) => block.instructions),
	);
	const intrinsic = instructions.find(
		(instruction) =>
			instruction.type === "loadIntrinsic" && instruction.intrinsic === "__directEval",
	);
	expect(intrinsic?.type).toBe("loadIntrinsic");
	if (intrinsic?.type !== "loadIntrinsic") {
		throw new Error("Expected a compiled direct eval");
	}
	const call = instructions.find(
		(instruction) =>
			instruction.type === "call" && instruction.registers[1] === intrinsic.registers[0],
	);
	expect(call?.type).toBe("call");
	if (call?.type !== "call") {
		throw new Error("Expected a direct eval call");
	}
	const encodedContext = instructions.find(
		(instruction) =>
			instruction.type === "createString" &&
			instruction.registers[0] === call.registers[10],
	);
	expect(encodedContext?.type).toBe("createString");
	if (encodedContext?.type !== "createString") {
		throw new Error("Expected an encoded direct eval context");
	}
	return decodeDirectEvalContext(
		String.fromCharCode(...program.stringConstants[encodedContext.stringIndex]!),
	);
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

test("contextual eval parsing inherits super, new.target, and private names", () => {
	const context = {
		allowSuperProperty: true,
		allowSuperCall: false,
		hasInstanceInitializer: false,
		allowNewTarget: true,
		privateNames: [{ name: "#value", flags: 2 }],
		varConflictNames: [],
	};
	expect(() =>
		parseScript("super.value; new.target; this.#value;", {
			strict: true,
			directEvalContext: context,
		}),
	).not.toThrow();
	expect(() =>
		parseScript("return 1;", { strict: true, directEvalContext: context }),
	).toThrow(SyntaxError);
});

test("contextual eval parsing allows super calls only in a derived constructor", () => {
	const inherited = {
		allowSuperProperty: true,
		allowSuperCall: true,
		hasInstanceInitializer: true,
		allowNewTarget: true,
		privateNames: [{ name: "#value", flags: 2 }],
		varConflictNames: [],
	};
	expect(() =>
		parseScript("super(); this.#value;", {
			strict: true,
			directEvalContext: inherited,
		}),
	).not.toThrow();
	expect(() =>
		parseScript("super();", {
			strict: true,
			directEvalContext: { ...inherited, allowSuperCall: false },
		}),
	).toThrow(SyntaxError);
});

test("direct eval conservatively captures every visible lexical environment", () => {
	const file = analyze(`
		function outer() {
			let outerValue = 1;
			return function inner() { return eval("outerValue"); };
		}
	`);
	const evalCall = file.scopes
		.flatMap((scope) => scope.bindings)
		.find((binding) => binding.name === "outerValue")!;
	const call = findNode(file.ast, "CallExpression")!;
	expect(evalCall.scopedTo).toBe("captured");
	expect(evalCall.usageNodes).toContain(call);
});

test("direct eval in an arrow captures lexical this and new.target", () => {
	const file = analyze(`
		function C() {
			return () => eval("[this, new.target]");
		}
	`);
	const call = findNode(file.ast, "CallExpression") as ESTree.CallExpression;
	expect(file.directEvalThisBindings.get(call)?.scopedTo).toBe("captured");
	expect(file.directEvalNewTargetBindings.get(call)?.scopedTo).toBe("captured");
});

test("direct eval context round-trips deduplicated var conflicts", () => {
	const context = {
		allowSuperProperty: true,
		allowSuperCall: false,
		hasInstanceInitializer: false,
		allowNewTarget: true,
		privateNames: [{ name: "#value", flags: 2 }],
		varConflictNames: ["parameter", "lexical", "parameter"],
	};
	expect(decodeDirectEvalContext(encodeDirectEvalContext(context))).toEqual({
		...context,
		varConflictNames: ["parameter", "lexical"],
	});
});

test("sloppy direct eval rejects var declarations that cross caller environments", () => {
	const directEvalContext = encodeDirectEvalContext({
		allowSuperProperty: false,
		allowSuperCall: false,
		hasInstanceInitializer: false,
		allowNewTarget: false,
		privateNames: [],
		varConflictNames: ["parameter", "lexical"],
	});
	const compile = (source: string, callerStrict = false) =>
		compileSourceToBuffer(source, { direct: true, callerStrict, directEvalContext });

	expect(() => compile("var parameter")).toThrow(SyntaxError);
	expect(() => compile("function lexical() {}")).toThrow(SyntaxError);
	expect(() => compile("if (true) { var lexical; }")).toThrow(SyntaxError);
	expect(() => compile("function nested() { var parameter; }")).not.toThrow();
	expect(() => compile("var unrelated")).not.toThrow();
	expect(() => compile('"use strict"; var parameter')).not.toThrow();
	expect(() => compile("var parameter", true)).not.toThrow();
});

test("generated direct eval contexts model parameter and lexical conflicts", () => {
	const parameterContext = generatedDirectEvalContext(
		`function f(parameter = eval("ignored")) {}`,
	);
	expect(parameterContext.varConflictNames).toContain("parameter");
	expect(parameterContext.varConflictNames).not.toContain("arguments");
	expect(() =>
		compileSourceToBuffer("var parameter", {
			direct: true,
			directEvalContext: encodeDirectEvalContext(parameterContext),
		}),
	).toThrow(SyntaxError);
	expect(() =>
		compileSourceToBuffer("var arguments", {
			direct: true,
			directEvalContext: encodeDirectEvalContext(parameterContext),
		}),
	).not.toThrow();

	const lexicalContext = generatedDirectEvalContext(`{
		let lexical;
		eval("ignored");
	}`);
	expect(lexicalContext.varConflictNames).toContain("lexical");
	expect(() =>
		compileSourceToBuffer("var lexical", {
			direct: true,
			directEvalContext: encodeDirectEvalContext(lexicalContext),
		}),
	).toThrow(SyntaxError);
});

test("generated direct eval contexts preserve the simple catch exception", () => {
	const simpleCatch = generatedDirectEvalContext(`
		try { throw 1; } catch (caught) { eval("ignored"); }
	`);
	expect(simpleCatch.varConflictNames).not.toContain("caught");
	expect(() =>
		compileSourceToBuffer("var caught", {
			direct: true,
			directEvalContext: encodeDirectEvalContext(simpleCatch),
		}),
	).not.toThrow();

	const destructuredCatch = generatedDirectEvalContext(`
		try { throw {}; } catch ({ caught }) { eval("ignored"); }
	`);
	expect(destructuredCatch.varConflictNames).toContain("caught");
	expect(() =>
		compileSourceToBuffer("var caught", {
			direct: true,
			directEvalContext: encodeDirectEvalContext(destructuredCatch),
		}),
	).toThrow(SyntaxError);
});
