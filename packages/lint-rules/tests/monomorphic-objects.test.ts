import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import { monomorphicObjects } from "../src/monomorphic-objects.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const typescript = { languageOptions: { parserOptions: { lang: "ts" as const } } };

function addedConditionally(output: string) {
	return {
		messageId: "addedConditionally",
		suggestions: [{ messageId: "initializeKey", output }],
	};
}

new RuleTester().run("monomorphic-objects", monomorphicObjects, {
	valid: [
		{
			name: "keys added in straight-line code give every object the same shape",
			code: "const o = { a: 1 };\no.b = 2;\nuse(o);",
		},
		{
			name: "conditional writes update keys the literal defines",
			code: "const o = { a: 1 };\nif (ready) o.a = 2;",
		},
		{
			name: "a conditional write after an unconditional addition updates the key",
			code: "const o = { a: 1 };\no.b = 0;\nif (ready) o.b = 2;",
		},
		{
			name: "dynamic keys use the object as a dictionary",
			code: "const counts = {};\nfor (const word of words) counts[word] = 1;",
		},
		{
			name: "a spread hides which keys the literal defines",
			code: "const o = { ...base };\nif (ready) o.b = 1;",
		},
		{
			name: "a Record annotation declares a dictionary",
			code: 'const env: Record<string, string> = {};\nif (ready) env.PATH = "/bin";',
			...typescript,
		},
		{
			name: "an index signature declares a dictionary",
			code: 'const env: { [name: string]: string } = {};\nif (ready) env.PATH = "/bin";',
			...typescript,
		},
		{
			name: "a Partial Record declares a dictionary",
			code: 'const byMode: Partial<Record<Mode, string>> = {};\nif (ready) byMode.fast = "a";',
			...typescript,
		},
		{
			name: "an assertion to Record declares a dictionary",
			code: 'const env = {} as Record<string, string>;\nif (ready) env.PATH = "/bin";',
			...typescript,
		},
		{
			name: "a reassigned binding may name another object",
			code: "let o = { a: 1 };\no = next();\nif (ready) o.b = 2;",
		},
		{
			name: "a shadowing parameter names another object",
			code: "const o = { a: 1 };\nfunction f(o) {\n\tif (ready) o.b = 2;\n}",
		},
		{
			name: "reading a missing key adds nothing",
			code: "const o = { a: 1 };\nif (o.b) use(o);",
		},
	],
	invalid: [
		{
			name: "a key added in a branch",
			code: "const o = { a: 1 };\nif (ready) o.b = 2;",
			errors: [
				addedConditionally("const o = { a: 1, b: undefined };\nif (ready) o.b = 2;"),
			],
		},
		{
			name: "a key added in a loop body",
			code: "const o = {};\nfor (const item of items) o.last = item;",
			errors: [
				addedConditionally(
					"const o = { last: undefined };\nfor (const item of items) o.last = item;",
				),
			],
		},
		{
			name: "a key added in a callback",
			code: "const o = { a: 1 };\nitems.forEach((item) => {\n\to.last = item;\n});",
			errors: [
				addedConditionally(
					"const o = { a: 1, last: undefined };\nitems.forEach((item) => {\n\to.last = item;\n});",
				),
			],
		},
		{
			name: "a key added on the right of a logical operator",
			code: "const o = { a: 1 };\nready && (o.b = 2);",
			errors: [
				addedConditionally("const o = { a: 1, b: undefined };\nready && (o.b = 2);"),
			],
		},
		{
			name: "a key added in a catch clause",
			code: "const o = { a: 1 };\ntry {\n\trun();\n} catch {\n\to.failed = true;\n}",
			errors: [
				addedConditionally(
					"const o = { a: 1, failed: undefined };\ntry {\n\trun();\n} catch {\n\to.failed = true;\n}",
				),
			],
		},
		{
			name: "one report per key, quoting keys that are not identifiers",
			code: 'const o = { a: 1 };\nif (json) o["content-type"] = "json";\nelse o["content-type"] = "text";',
			errors: [
				addedConditionally(
					'const o = { a: 1, "content-type": undefined };\nif (json) o["content-type"] = "json";\nelse o["content-type"] = "text";',
				),
			],
		},
	],
});
