import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import { preferMap } from "../src/prefer-map.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const dataKeys = [{ messageId: "dataKeys" }];

new RuleTester().run("prefer-map", preferMap, {
	valid: [
		{
			name: "fixed keys use the object as a record",
			code: 'const o = {};\no.a = 1;\no["b"] = 2;\nuse(o.a, o["b"]);',
		},
		{
			name: "an object only written with data keys is output",
			code: "const headers = {};\nfor (const [name, value] of pairs) headers[name] = value;\nsend(headers);",
		},
		{
			name: "a literal that defines keys is a record",
			code: "const o = { a: 1 };\no[key] = 2;\nuse(o[key]);",
		},
		{
			name: "a reassigned binding may name another object",
			code: "let o = {};\no = other();\no[key] = 1;\nuse(o[key]);",
		},
	],
	invalid: [
		{
			name: "a counter keyed by data",
			code: "const counts = {};\nfor (const word of words) counts[word] = (counts[word] ?? 0) + 1;",
			errors: dataKeys,
		},
		{
			name: "a membership test with in",
			code: "const seen = Object.create(null);\nfor (const id of ids) {\n\tif (id in seen) continue;\n\tseen[id] = true;\n}",
			errors: dataKeys,
		},
		{
			name: "a compound assignment both reads and writes",
			code: "const totals = {};\ntotals[key] += 1;",
			errors: dataKeys,
		},
		{
			name: "a Record annotation still describes a map",
			code: "const cache: Record<string, string> = {};\ncache[file] ??= load(file);\nuse(cache[file]);",
			languageOptions: { parserOptions: { lang: "ts" } },
			errors: dataKeys,
		},
	],
});
