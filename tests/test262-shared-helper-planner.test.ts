import { Script, createContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { planTest262SharedHelpers } from "../src/test262/shared-helper-plan.ts";
import type { Test262File } from "../src/test262/types.ts";

function file(
	content: string,
	flags: Array<string> = [],
	includes: Array<string> = [],
): Test262File {
	return {
		path: "test/example.js",
		frontmatter: { flags, includes },
		content,
		result: "UNKNOWN",
	};
}

function execute(
	content: string,
	harness: Record<string, string>,
	includes: Array<string> = [],
): unknown {
	const plan = planTest262SharedHelpers(
		file(content, [], includes),
		(name) => harness[name]!,
	);
	const context = createContext({});
	for (const helper of plan.helpers) new Script(helper.source).runInContext(context);
	return new Script(plan.testSource).runInContext(context);
}

describe("Test262 harness source plans", () => {
	it("initializes harness globals before instantiating test declarations", () => {
		expect(
			execute(
				"function Array() {} if (originalArray === Array) throw new Error('test hoisted before harness'); originalArray.name;",
				{ "assert.js": "var originalArray = Array;", "sta.js": "" },
			),
		).toBe("Array");
	});

	it("preserves each script's directives and harness evaluation order", () => {
		expect(
			execute(
				"'use strict'; if ((function () { return this; })() !== undefined) throw new Error('lost directive'); order.join(',');",
				{
					"assert.js": "var order = ['assert'];",
					"sta.js": "order.push('sta');",
					"extra.js": "order.push('extra');",
				},
				["extra.js"],
			),
		).toBe("assert,sta,extra");
	});

	it("keeps global lexical bindings visible to subsequent scripts", () => {
		expect(
			execute("if ('value' in globalThis) throw new Error('lexical leaked'); value;", {
				"assert.js": "const value = 42;",
				"sta.js": "",
			}),
		).toBe(42);
	});

	it("preserves raw bytes and omits every harness include", () => {
		const source = '#!"use strict"\n/*--- flags: [raw] ---*/\nwith ({}) {}';
		const plan = planTest262SharedHelpers(file(source, ["raw"], ["ignored.js"]), () => {
			throw new Error("raw tests must not load harness files");
		});
		expect(plan.helpers).toEqual([]);
		expect(plan.testSource).toBe(source);
		expect(() => new Script(plan.testSource)).not.toThrow();
	});

	it("places async completion support before declared includes", () => {
		const plan = planTest262SharedHelpers(
			file("$DONE();", ["async"], ["asyncHelpers.js"]),
			(name) => name,
		);
		expect(plan.helpers.map((helper) => helper.path)).toEqual([
			"harness/assert.js",
			"harness/sta.js",
			"harness/doneprintHandle.js",
			"harness/asyncHelpers.js",
		]);
	});
});
