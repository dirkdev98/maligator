import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TEST262_METADATA } from "../src/test262/constants.ts";
import type * as Test262Runner from "../src/test262/runtime.ts";
import type { Test262File, Test262Frontmatter } from "../src/test262/types.ts";

const directory = mkdtempSync(path.join(os.tmpdir(), "mal-test262-execution-"));
const originalReportPath = TEST262_METADATA.reportPath;
const originalWorkPath = TEST262_METADATA.workPath;
const originalCorpusPath = TEST262_METADATA.path;
let runner: typeof Test262Runner;

beforeAll(async () => {
	TEST262_METADATA.reportPath = path.join(directory, "reports");
	TEST262_METADATA.workPath = path.join(directory, "work");
	TEST262_METADATA.path = path.join(directory, "corpus");
	mkdirSync(path.join(TEST262_METADATA.path, "harness"), { recursive: true });
	for (const name of ["assert.js", "sta.js", "doneprintHandle.js", "testTypedArray.js"]) {
		copyFileSync(
			path.join(originalCorpusPath, "harness", name),
			path.join(TEST262_METADATA.path, "harness", name),
		);
	}
	writeFileSync(
		path.join(TEST262_METADATA.path, "harness", "lexical.js"),
		`
		const sharedConstant = { value: 7 };
		let sharedMutable = 1;
		class SharedClass {}
		var sharedVar = 3;
		globalThis.sharedMutable = 99;
		function readShared() { return sharedMutable; }
		function readLater() { return laterBinding; }
		function deleteShared() { return delete sharedConstant; }
	`,
	);
	mkdirSync(path.join(TEST262_METADATA.path, "test"), { recursive: true });
	for (const [name, source] of [
		[
			"tla_FIXTURE.js",
			"await 0; globalThis.moduleVisits = (globalThis.moduleVisits || 0) + 1;",
		],
		["parent_FIXTURE.js", "import './tla_FIXTURE.js';"],
		["grandparent_FIXTURE.js", "import './parent_FIXTURE.js';"],
		["poison_FIXTURE.js", "throw 'expected rejection';"],
	])
		writeFileSync(path.join(TEST262_METADATA.path, "test", name!), source!);

	runner = await import("../src/test262/runtime.ts");
});

afterAll(() => {
	vi.unstubAllEnvs();
	TEST262_METADATA.reportPath = originalReportPath;
	TEST262_METADATA.workPath = originalWorkPath;
	TEST262_METADATA.path = originalCorpusPath;
	rmSync(directory, { recursive: true, force: true });
});

function file(
	name: string,
	content: string,
	frontmatter: Test262Frontmatter = {},
): Test262File {
	return {
		path: `test/runner-contract-${name}.js`,
		content,
		frontmatter,
		result: "UNKNOWN",
	};
}

function cases(): Array<Test262File> {
	return [
		file("raw", '#!"use strict"\nwith ({}) {}', { flags: ["raw"] }),
		file(
			"directive",
			'"use strict"; if ((function () { return this; })() !== undefined) throw new Error("lost directive");',
			{ flags: ["noStrict"] },
		),
		file(
			"module",
			'if (typeof globalThis.assert !== "function" || globalThis.assert !== assert) throw new Error("harness not global"); export {};',
			{ flags: ["module"] },
		),
		file(
			"declarations",
			'function Int8Array() {} if (typedArrayConstructors.indexOf(Int8Array) !== -1) throw new Error("test instantiated before harness");',
			{ includes: ["testTypedArray.js"] },
		),
		file(
			"lexical-access",
			`
			assert.sameValue(sharedConstant.value, 7);
			assert.sameValue(typeof sharedConstant, "object");
			assert.sameValue(typeof absentBinding, "undefined");
			assert.sameValue("sharedConstant" in globalThis, false);
			sharedMutable += 2;
			assert.sameValue(readShared(), 3);
			sharedMutable = 4;
			assert.sameValue(readShared(), 4);
			assert.sameValue(globalThis.sharedMutable, 99);
			assert.sameValue((0, eval)('"use strict"; var sharedMutable = 12; sharedMutable;'), 12);
			assert.sameValue(readShared(), 4);
			assert.sameValue((0, eval)('"use strict"; function sharedConstant() { return 17; } sharedConstant();'), 17);
			assert.sameValue(sharedConstant.value, 7);
			assert.throws(TypeError, () => { sharedConstant = 5; });
			var evalCounter = 0;
			assert.sameValue(eval("++evalCounter"), 1);
			assert.sameValue(evalCounter, 1);
			assert.sameValue((0, eval)('"use strict"; ++sharedMutable'), 5);
			assert.sameValue(readShared(), 5);
			assert.sameValue(deleteShared(), false);
			assert.sameValue(new SharedClass() instanceof SharedClass, true);
			assert.throws(ReferenceError, readLater);
			assert.throws(ReferenceError, () => typeof laterBinding);
			let laterBinding = 8;
			assert.sameValue(readLater(), 8);
		`,
			{ includes: ["lexical.js"] },
		),
		...[
			["lexical-redeclare", "let sharedMutable;"],
			["var-redeclare", "var sharedMutable;"],
			["function-redeclare", "function sharedMutable() {}"],
			["var-lexical-conflict", "let sharedVar;"],
		].map(([name, content]) =>
			file(name!, content!, {
				includes: ["lexical.js"],
				negative: { phase: "runtime", type: "SyntaxError" },
			}),
		),
		file(
			"module-relocation",
			`
			import './parent_FIXTURE.js';
			await import('./grandparent_FIXTURE.js');
			assert.sameValue(globalThis.moduleVisits, 1);
			$DONE();
		`,
			{
				flags: ["module", "async"],
				features: ["top-level-await", "dynamic-import"],
				includes: ["lexical.js"],
			},
		),
		file(
			"import-rejection-relocation",
			`
			async function* values() { yield import('./poison_FIXTURE.js'); }
			values().next().then(() => $DONE(new Error("lost rejection")), error => {
				assert.sameValue(error, "expected rejection");
				$DONE();
			});
		`,
			{
				flags: ["async"],
				features: ["dynamic-import", "async-iteration"],
				includes: ["lexical.js"],
			},
		),

		file("async-pass", "Promise.resolve().then(() => $DONE());", {
			flags: ["async"],
		}),
		file("async-throw", '$DONE(); throw new Error("after done");', {
			flags: ["async"],
		}),
		file("async-missing", "Promise.resolve();", { flags: ["async"] }),
		file("spoofed-error", 'throw "TypeError: this is a string";', {
			negative: { phase: "runtime", type: "TypeError" },
		}),
		file(
			"renamed-error",
			'var error = new TypeError("expected"); error.name = "RangeError"; error.stack = "RangeError: misleading"; throw error;',
			{ negative: { phase: "runtime", type: "TypeError" } },
		),
		file("blocking-host", 'throw new Error("inapplicable test executed");', {
			flags: ["CanBlockIsTrue"],
		}),
		file(
			"native-call-contracts",
			`
			(function () {
				function count(value) { return arguments.length + value; }
				assert.sameValue(count(1, 2, 3), 4);
				class Price { quote(r) { return r.x + (r.y > 0); } }
				const price = new Price();
				for (let i = 0; i < 3; i++) assert.sameValue(price.quote({x: i, y: 1}), i + 1);
				function compare(a, b) { return a - b; }
				assert.sameValue([3, 1, 2].sort(compare).join(), "1,2,3");
				function select(s) { switch (s) { case 'red': return 1; case 'blue': return 2; default: return 0; } }
				assert.sameValue(select('red'), 1);
			})();
		`,
		),
	];
}

describe("Test262 native execution contract", () => {
	it.each(["compiled", "interpreted", "wire"] as const)(
		"preserves source boundaries and verdicts on %s",
		async (backend) => {
			vi.stubEnv("MAL_INTERP", backend === "interpreted" ? "1" : "0");
			vi.stubEnv("T262_WIRE", backend === "wire" ? "1" : "0");
			vi.stubEnv("T262_OBJCACHE", "1");
			runner.test262PrepareBuild();
			for (const variant of ["strict", "sloppy"] as const) {
				vi.stubEnv("T262_VARIANT", variant);
				const files = cases();
				const expected = files.map((input) => {
					if (
						input.frontmatter.flags?.includes("CanBlockIsTrue") ||
						(variant === "strict" &&
							(input.frontmatter.flags?.includes("raw") ||
								input.frontmatter.flags?.includes("noStrict"))) ||
						(variant === "sloppy" && input.frontmatter.flags?.includes("module"))
					)
						return "SKIPPED";
					return ["async-throw", "async-missing", "spoofed-error"].some((name) =>
						input.path.endsWith(`-${name}.js`),
					)
						? "FAILED"
						: "PASSED";
				});
				for (let run = 0; run < 2; run++) {
					runner.test262ResetStats();
					for (const input of files) input.result = "UNKNOWN";
					await runner.test262RunBatch(files, 0);
					expect(
						files.map((input) => input.result),
						JSON.stringify(runner.getFailuresWithSamples()),
					).toEqual(expected);
				}
				await runner.test262RunSingle(
					files.find((input) => input.path.endsWith("async-throw.js"))!,
					0,
				);
				expect(files.find((input) => input.path.endsWith("async-throw.js"))!.result).toBe(
					"FAILED",
				);
				await runner.test262RunSingle(
					files.find((input) => input.path.endsWith("renamed-error.js"))!,
					0,
				);
				expect(
					files.find((input) => input.path.endsWith("renamed-error.js"))!.result,
				).toBe("PASSED");
			}
		},
		300_000,
	);
});
