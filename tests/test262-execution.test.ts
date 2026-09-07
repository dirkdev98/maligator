import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TEST262_METADATA } from "../src/test262/constants.ts";
import type * as Test262Runner from "../src/test262/runtime.ts";
import type { Test262File, Test262Frontmatter } from "../src/test262/types.ts";

const directory = mkdtempSync(path.join(os.tmpdir(), "mal-test262-execution-"));
const originalBuildPath = TEST262_METADATA.buildPath;
let runner: typeof Test262Runner;

beforeAll(async () => {
	TEST262_METADATA.buildPath = directory;
	runner = await import("../src/test262/runtime.ts");
});

afterAll(() => {
	vi.unstubAllEnvs();
	TEST262_METADATA.buildPath = originalBuildPath;
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
				const expected = [
					variant === "strict" ? "SKIPPED" : "PASSED",
					variant === "strict" ? "SKIPPED" : "PASSED",
					variant === "strict" ? "PASSED" : "SKIPPED",
					"PASSED",
					"PASSED",
					"FAILED",
					"FAILED",
					"FAILED",
					"PASSED",
					"SKIPPED",
				];
				for (let run = 0; run < 2; run++) {
					runner.test262ResetStats();
					for (const input of files) input.result = "UNKNOWN";
					await runner.test262RunBatch(files, 0);
					expect(
						files.map((input) => input.result),
						JSON.stringify(runner.getFailuresWithSamples()),
					).toEqual(expected);
				}
				await runner.test262RunSingle(files[5]!, 0);
				expect(files[5]!.result).toBe("FAILED");
				await runner.test262RunSingle(files[8]!, 0);
				expect(files[8]!.result).toBe("PASSED");
			}
		},
		300_000,
	);
});
