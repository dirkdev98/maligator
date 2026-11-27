import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import { noDeleteProperty } from "../src/no-delete-property.ts";

RuleTester.describe = describe;
RuleTester.it = it;

function deletedKey(output?: string) {
	return {
		messageId: "deletedKey",
		suggestions: output === undefined ? null : [{ messageId: "assignUndefined", output }],
	};
}

new RuleTester().run("no-delete-property", noDeleteProperty, {
	valid: [
		{
			name: "deleting the last key leaves the other keys in their slots",
			code: "const o = { a: 1, b: 2 };\nif (done) delete o.b;",
		},
		{
			name: "dynamic keys use the object as a dictionary",
			code: "const o = { a: 1, b: 2 };\ndelete o[key];",
		},
		{
			name: "integer keys are elements, not shaped keys",
			code: 'const o = { 0: "a", b: 1 };\ndelete o[0];',
		},
		{
			name: "objects the rule cannot see created may be dictionaries",
			code: "function clear(options) {\n\tdelete options.cache;\n\tdelete process.env.HOME;\n}",
		},
		{
			name: "class instances have a key order the rule cannot see",
			code: "class Cache {\n\tclear() {\n\t\tdelete this.value;\n\t}\n}",
		},
		{
			name: "a spread literal copies keys the rule cannot see",
			code: "const o = { ...base, b: 1 };\ndelete o.a;",
		},
		{
			name: "a Record annotation declares a dictionary",
			code: 'const env: Record<string, string> = { A: "1", B: "2" };\ndelete env.A;',
			languageOptions: { parserOptions: { lang: "ts" } },
		},
		{
			name: "a reassigned binding may name another object",
			code: "let o = { a: 1, b: 2 };\no = next();\ndelete o.a;",
		},
	],
	invalid: [
		{
			name: "a key that other keys follow",
			code: "const o = { a: 1, b: 2 };\nif (done) delete o.a;",
			errors: [deletedKey("const o = { a: 1, b: 2 };\nif (done) o.a = undefined;")],
		},
		{
			name: "a delete whose result is used has no suggestion",
			code: "const o = { a: 1, b: 2 };\nconst removed = delete o.a;",
			errors: [deletedKey()],
		},
	],
});
