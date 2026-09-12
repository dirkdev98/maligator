import { equal, ok } from "node:assert";
import { describe, it } from "vitest";
import { attachCoreCompilerSiteFacts } from "../src/compiler/core/compiler-site-facts.ts";
import type { CoreCompilation } from "../src/compiler/core/core-compilation.ts";
import { sourceSiteId } from "../src/compiler/shared/compiler-facts.ts";

function siteFor(inlinedFunctionIndex?: number) {
	const caller = {
		id: 0,
		metadata: { sourcePath: "/caller.js" },
		blockIds: () => [0],
		bodyInstructionIds: () => [0],
		instructionOpcodeName: () => "createObject",
		instructionAttributes: () => ({}),
		instructionSourcePosition: () => 0,
	};
	const inlineOwner = {
		...caller,
		id: 4000,
		metadata: { sourcePath: "/inlined owner.js" },
		bodyInstructionIds: () => [],
	};
	const functions = new Map([
		[0, caller],
		[4000, inlineOwner],
	]);
	const compilation = {
		program: {
			functionIds: () => functions.keys(),
			function: (id: number) => functions.get(id),
			hasFunction: (id: number) => functions.has(id),
			sourcePositions: [{ line: 7, column: 2, inlinedFunctionIndex }],
			stringConstants: [],
		},
		context: { facts: { immutableGlobalBindings: new Map() } },
		plan: { recipes: { count: 0 }, directEntries: [] },
	} as unknown as CoreCompilation;
	const result = attachCoreCompilerSiteFacts(compilation).context.facts.sites;
	const site = result.get("0:0:0:createObject");
	ok(site);
	return site;
}

describe("Indexed inline source owners", () => {
	it("preserves local fallback and sparse inline-owner identities", () => {
		equal(
			siteFor().sourceSite,
			sourceSiteId("/caller.js", 7, 2, "residual:createObject"),
		);
		equal(
			siteFor(4000).sourceSite,
			sourceSiteId("/inlined owner.js", 7, 2, "residual:createObject"),
		);
		equal(siteFor(-0).sourceSite, siteFor(0).sourceSite);
	});

	it("retains the fact without inventing a source for missing inline owners", () => {
		for (const id of [1, -1, 1.5, NaN]) {
			const site = siteFor(id);
			equal(site.sourceSite, undefined);
			ok(site.shape);
			equal(site.functionId, `${encodeURIComponent("/caller.js")}#0`);
		}
	});
});
