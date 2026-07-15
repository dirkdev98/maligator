import { describe, expect, it } from "vitest";
import { planTest262SharedHelpers } from "../src/test262/shared-helper-plan.ts";
import type { Test262File } from "../src/test262/types.ts";

function testFile(content: string, includes: Array<string> = []): Test262File {
	return {
		path: "test/language/example.js",
		frontmatter: { includes },
		content,
		result: "UNKNOWN",
	};
}

const harness: Record<string, string> = {
	"assert.js": "function assert() {}",
	"sta.js": "var $ERROR = function () {};",
	"propertyHelper.js": "function verifyProperty() {}",
	"testTypedArray.js": "var typedArrayConstructors = [];",
	"testIntl.js": "function testWithIntlConstructors() {}",
};

describe("Test262 shared-helper planner", () => {
	it("plans standard and eligible high-value helpers in source order", () => {
		const plan = planTest262SharedHelpers(
			testFile("assert.sameValue(1, 1);", ["propertyHelper.js", "testIntl.js"]),
			true,
			(name) => harness[name]!,
		);

		expect(plan.kind).toBe("shared");
		if (plan.kind === "shared") {
			expect(plan.helpers.map((helper) => helper.path)).toEqual([
				"harness/assert.js",
				"harness/sta.js",
				"harness/propertyHelper.js",
				"harness/testIntl.js",
			]);
			expect(plan.helpers[1]!.source.startsWith(";")).toBe(true);
			expect(plan.helpers[1]!.source.startsWith(";\n")).toBe(false);
			expect(plan.testSource.startsWith(";")).toBe(true);
			expect(plan.testSource.startsWith(";\n")).toBe(false);
		}
	});

	it("keeps lexical helpers, lexical tests, and unsupported includes on legacy composition", () => {
		const lexicalHarness: Record<string, string> = {
			...harness,
			"assert.js": "class Assert {}",
		};
		expect(
			planTest262SharedHelpers(
				testFile("var value;"),
				true,
				(name) => lexicalHarness[name]!,
			).kind,
		).toBe("legacy");
		expect(
			planTest262SharedHelpers(
				testFile("const value = 1;"),
				true,
				(name) => harness[name]!,
			).kind,
		).toBe("legacy");
		expect(
			planTest262SharedHelpers(
				testFile("var value;", ["realm.js"]),
				true,
				(name) => harness[name]!,
			).kind,
		).toBe("legacy");
	});

	it("keeps colliding helper and test declarations on legacy composition", () => {
		expect(
			planTest262SharedHelpers(
				testFile("function assert() {}"),
				true,
				(name) => harness[name]!,
			).kind,
		).toBe("legacy");
	});

	it("keeps test var and function declarations on legacy composition", () => {
		for (const content of ["var Float16Array;", "function Float16Array() {}"]) {
			expect(
				planTest262SharedHelpers(
					testFile(content, ["testTypedArray.js"]),
					true,
					(name) => harness[name]!,
				).kind,
			).toBe("legacy");
		}
	});

	it("keeps modules, async tests, and negative tests on legacy composition", () => {
		for (const frontmatter of [
			{ flags: ["module"] },
			{ flags: ["async"] },
			{ negative: { phase: "parse" as const, type: "SyntaxError" } },
		]) {
			const file = { ...testFile("var value;"), frontmatter };
			expect(planTest262SharedHelpers(file, true, (name) => harness[name]!).kind).toBe(
				"legacy",
			);
		}
	});
});
