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
			name: "dynamic keys use the object as a dictionary",
			code: "const o = { a: 1 };\ndelete o[key];",
		},
		{
			name: "objects the rule cannot see created may be dictionaries",
			code: "function clear(options) {\n\tdelete options.cache;\n\tdelete process.env.HOME;\n}",
		},
		{
			name: "a spread literal copies keys the rule cannot see",
			code: "const o = { ...base };\ndelete o.a;",
		},
		{
			name: "a Record annotation declares a dictionary",
			code: 'const env: Record<string, string> = { A: "1" };\ndelete env.A;',
			languageOptions: { parserOptions: { lang: "ts" } },
		},
		{
			name: "a reassigned binding may name another object",
			code: "let o = { a: 1 };\no = next();\ndelete o.a;",
		},
		{
			name: "array indexes are elements, not shaped keys",
			code: 'const o = { 0: "a" };\ndelete o[0];',
		},
		{
			name: "this outside a class is not an instance",
			code: "function reset() {\n\tdelete this.cache;\n}",
		},
		{
			name: "this in a static method is the class itself",
			code: "class Store {\n\tstatic reset() {\n\t\tdelete this.cache;\n\t}\n}",
		},
	],
	invalid: [
		{
			name: "a key deleted from a record",
			code: "const o = { a: 1, b: 2 };\nif (done) delete o.b;",
			errors: [deletedKey("const o = { a: 1, b: 2 };\nif (done) o.b = undefined;")],
		},
		{
			name: "a key deleted from a class instance",
			code: "class Cache {\n\tclear() {\n\t\tdelete this.value;\n\t}\n}",
			errors: [
				deletedKey("class Cache {\n\tclear() {\n\t\tthis.value = undefined;\n\t}\n}"),
			],
		},
		{
			name: "an arrow function in a method keeps the instance as this",
			code: "class Cache {\n\tclear() {\n\t\tkeys.forEach(() => {\n\t\t\tdelete this.value;\n\t\t});\n\t}\n}",
			errors: [
				deletedKey(
					"class Cache {\n\tclear() {\n\t\tkeys.forEach(() => {\n\t\t\tthis.value = undefined;\n\t\t});\n\t}\n}",
				),
			],
		},
		{
			name: "a delete whose result is used has no suggestion",
			code: "const o = { a: 1 };\nconst removed = delete o.a;",
			errors: [deletedKey()],
		},
	],
});
