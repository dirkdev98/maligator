import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
import type { BackendPairResult } from "../../src/test-harness.ts";
const fixture = "tests/local/captured-date-parse.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-captured-parser-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
const realmPairs: Array<BackendPairResult> = [];
beforeAll(() => {
	for (const realms of [false, true]) {
		const built = buildBackendPairFromOneProgramImage({
			fixture,
			name: `captured-date-parse-${realms}`,
			outDir,
			mainFile: HOST_MAIN,
			nativeStackRoots: "precise",
			config: resolveBuildConfig({
				engine: { primordials: "mutable", realms, eval: false },
			}),
		});
		realmPairs.push(built);
		const fn = built.programImage.native.functions.find(
			(fn) =>
				String.fromCharCode(
					...(built.programImage.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
				) === "captured",
		)!;
		expect(
			fn.body.instructions.some(
				(op) =>
					op.opcode === "CALL_KNOWN" &&
					op.operation === "Date.parse" &&
					op.specialized === "Date.parse",
			),
		).toBe(true);
		if (realms) {
			const ordinary = built.programImage.native.functions.find(
				(fn) =>
					String.fromCharCode(
						...(built.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
							[]),
					) === "ordinary",
			)!;
			expect(
				ordinary.body.instructions.some(
					(op) =>
						op.opcode === "CALL_KNOWN" &&
						op.operation === "Date.parse" &&
						op.specialized === "Date.parse",
				),
			).toBe(true);
		}
	}
});
describe("Date.parse captured before argument conversion", () => {
	it.each([
		["parses String inputs and retains boxed conversion", "strings"],
		["retains the selected parser across argument getter mutation", "argument-method"],
		["retains a replacement selected before argument restoration", "argument-restore"],
		["propagates an argument getter throw before parsing", "argument-throw"],
		["finishes ignored arguments before the late String guard", "ordinary-extra"],
		["propagates ignored argument throws before parsing", "ordinary-extra-throw"],
		["parses strings and converted values without repeating conversion", "values"],
		["returns NaN without reading a missing operand", "empty"],
		["retains the selected parser after method replacement", "method"],
		["retains the selected parser after global replacement", "global"],
		["defers a replacement accessor until the next call", "accessor"],
		["observes replacements at later namespace loads", "later"],
		["propagates the original conversion throw", "throw"],
		["evaluates ignored extra arguments after conversion", "extra"],
		["propagates an extra argument throw before parsing", "extra-throw"],
		["keeps unknown-input conversion in the ordinary call", "unknown"],
		["preserves Symbol conversion errors on ordinary calls", "symbol"],
		["retains a shadowed namespace", "shadow"],
	])("%s", (_behavior, mode) => {
		const env = { CAPTURED_DATE_PARSE_CASE: mode, MAL_HOST_GC: "1" };
		const expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
			encoding: "utf8",
			env: { ...process.env, ...env },
		});
		for (const built of realmPairs)
			for (const binary of [built.compiled, built.interpreted])
				for (const stress of [{}, STRESS_ENV])
					expect(runToStdout(binary, { env: { ...env, ...stress } })).toBe(expected);
	});
	it("retains selected parser semantics in a static interpreted image", () => {
		const binary = buildNativeBinary({
			fixture: "tests/local/captured-date-parse-c-image.js",
			name: "captured-date-parse-static",
			outDir,
			compiled: false,
			mainFile: "runtime/test262_main.c",
			nativeStackRoots: "precise",
			config: resolveBuildConfig({
				engine: { primordials: "mutable", realms: false, eval: false },
			}),
		});
		expect(runToStdout(binary, { env: STRESS_ENV })).toBe(
			"captured-date-parse-c-image PASS\n",
		);
	});
});
