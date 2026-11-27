import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import { noDynamicGlobalAccess } from "../src/no-dynamic-global-access.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const typescript = { languageOptions: { parserOptions: { lang: "ts" as const } } };
const untraced = [{ messageId: "untraced" }];

new RuleTester().run("no-dynamic-global-access", noDynamicGlobalAccess, {
	valid: [
		{
			name: "a member access with a fixed key names the global",
			code: 'globalThis.fetch;\nglobalThis["queueMicrotask"]();\nglobal.process = undefined;',
		},
		{
			name: "typeof and identity comparisons name no other global",
			code: 'typeof globalThis === "object";\nif (scope === globalThis) run();',
		},
		{
			name: "a type assertion around a named read is erased",
			code: "(globalThis as unknown as { count?: number }).count = 1;",
			...typescript,
		},
		{
			name: "a type query is erased",
			code: "let fetchLike: typeof globalThis.fetch;",
			...typescript,
		},
		{
			name: "a local binding named like the global object is not it",
			code: "function read(global, key) {\n\treturn global[key];\n}",
		},
	],
	invalid: [
		{ name: "a computed key", code: "globalThis[name];", errors: untraced },
		{ name: "a computed key on global", code: "global[name];", errors: untraced },
		{ name: "an alias", code: "const scope = globalThis;", errors: untraced },
		{ name: "destructuring", code: "const { fetch } = globalThis;", errors: untraced },
		{ name: "the in operator", code: '"fetch" in globalThis;', errors: untraced },
		{
			name: "passing the global object on",
			code: 'Reflect.get(globalThis, "fetch");',
			errors: untraced,
		},
		{
			name: "an alias through a type assertion",
			code: "const scope = globalThis as unknown as { count: number };",
			errors: untraced,
			...typescript,
		},
	],
});
