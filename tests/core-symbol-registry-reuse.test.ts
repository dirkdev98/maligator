import { expect, it } from "vitest";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";
import {
	registryKeys,
	registryProfiles,
	registrySource,
} from "./helpers/symbol-registry-reuse.ts";

for (const key of registryKeys) {
	for (const profile of registryProfiles) {
		it(`reuses the registered identity for ${key} in ${profile} after retaining the first call`, () => {
			const result = inspectStaticValueFunction(registrySource(key, profile), "target");
			expect(
				result.core.filter((op) => op.attributes.operation === "Symbol.for"),
			).toHaveLength(1);
			expect(result.structure.genericLookups).toBe(0);
			expect(result.structure.genericCalls).toBeGreaterThan(0);
		});
		it(`preserves mutable registry dispatch for ${key} in ${profile}`, () => {
			const result = inspectStaticValueFunction(registrySource(key, profile), "target", {
				locked: false,
			});
			expect(result.structure.genericLookups).toBeGreaterThan(0);
			expect(result.structure.genericCalls).toBeGreaterThan(1);
		});
	}
}

it.each([
	[
		"repeated object coercion",
		"const a=Symbol.for(x);effect(a);return [a,Symbol.for(x)];",
		2,
	],
	[
		"different keys",
		"const a=Symbol.for(String(x));return [a,Symbol.for(String(y))];",
		2,
	],
	["first unused insertion", "Symbol.for(String(x));return 0;", 1],
	[
		"handler after a failed conversion",
		"try{Symbol.for(x);}catch(e){return Symbol.for(x);}return 0;",
		2,
	],
	[
		"separate control-flow arms",
		"const k=String(x);if(y){return Symbol.for(k);}effect();return Symbol.for(k);",
		2,
	],
] as const)("retains %s", (_name, body, count) => {
	const result = inspectStaticValueFunction(
		`function target(x,y,effect){${body}}globalThis.target=target;`,
		"target",
	);
	expect(
		result.core.filter((op) => op.attributes.operation === "Symbol.for"),
	).toHaveLength(count);
});

it("retains the registry call after suspension", () => {
	const result = inspectStaticValueFunction(
		"function* target(x){const k=String(x);const a=Symbol.for(k);yield a;return Symbol.for(k);}globalThis.target=target;",
		"target",
	);
	expect(
		result.core.filter((op) => op.attributes.operation === "Symbol.for"),
	).toHaveLength(2);
});

it("preserves two fresh Symbol identities for one primitive description", () => {
	const result = inspectStaticValueFunction(
		"function target(x){const k=String(x);return [Symbol(k),Symbol(k)];}globalThis.target=target;",
		"target",
	);
	expect(result.core.filter((op) => op.attributes.operation === "Symbol")).toHaveLength(
		2,
	);
});
