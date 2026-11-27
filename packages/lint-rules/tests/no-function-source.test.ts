import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import { noFunctionSource } from "../src/no-function-source.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const typescript = { languageOptions: { parserOptions: { lang: "ts" as const } } };

function stringified(...subjects: Array<string>) {
	return subjects.map((subject) => ({ messageId: "stringified", data: { subject } }));
}

new RuleTester().run("no-function-source", noFunctionSource, {
	valid: [
		{
			name: "a function's text that only reaches console is logging",
			code: 'function handler() {}\nconsole.log(handler.toString());\nconsole.log(`handler: ${handler}`);\nconsole.error("failed in " + String(handler));\nconsole.log(Function.prototype.toString.call(handler));',
		},
		{
			name: "parameters and imports may hold anything",
			code: 'import { handler } from "./handler.js";\nString(handler);\nexport function describe(fn) {\n\treturn fn.toString();\n}',
		},
		{
			name: "a binding reassigned after its definition may hold anything",
			code: 'let format = () => "";\nformat = "plain";\nString(format);',
		},
		{
			name: "a tagged template receives the function, not its text",
			code: "function handler() {}\nhtml`<button onclick=${handler}>`;",
		},
		{
			name: "local bindings named String or Function are not the globals",
			code: "const String = (value) => value;\nfunction handler() {}\nString(handler);\nfunction read(Function) {\n\treturn Function.prototype.toString;\n}",
		},
		{
			name: "objects with their own toString are not functions",
			code: 'const point = { toString() { return "p"; } };\npoint.toString();\nString(point);\n`${point}`;',
		},
	],
	invalid: [
		{
			name: "Function.prototype.toString called on any function",
			code: "const source = Function.prototype.toString.call(fn);",
			errors: [{ messageId: "functionToString" }],
		},
		{
			name: "an alias of Function.prototype.toString",
			code: "const toSource = Function.prototype.toString;",
			errors: [{ messageId: "functionToString" }],
		},
		{
			name: "toString on a function declaration",
			code: "function handler(a, b) {}\nhandler.toString();",
			errors: stringified("`handler`"),
		},
		{
			name: "String on an arrow function binding",
			code: "const add = (a, b) => a + b;\nString(add);",
			errors: stringified("`add`"),
		},
		{
			name: "a class in a template literal",
			code: "class Point {}\nconst text = `${Point}`;",
			errors: stringified("`Point`"),
		},
		{
			name: "concatenation with a string",
			code: 'function handler() {}\nconst a = "source: " + handler;\nconst b = handler + "";\nconst c = prefix + "/" + handler;',
			errors: stringified("`handler`", "`handler`", "`handler`"),
		},
		{
			name: "an inline function or class expression",
			code: "(function () {}).toString();\nString(class {});",
			errors: stringified("this function", "this class"),
		},
		{
			name: "source that passes through other code before logging is still read",
			code: "function handler() {}\nconsole.log(parse(handler.toString()));",
			errors: stringified("`handler`"),
		},
		{
			name: "type assertions are erased",
			code: "function handler() {}\nString(handler as unknown);\n(handler as Function).toString();\n(Function.prototype as any).toString.call(handler);",
			errors: [
				...stringified("`handler`", "`handler`"),
				{ messageId: "functionToString" },
			],
			...typescript,
		},
	],
});
