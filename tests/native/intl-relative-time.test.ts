import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/intl-relative-time.js";
const gcEnvironments = ["MAL_ASAN", "MAL_UBSAN", "MAL_TSAN"].some(
	(key) => process.env[key] === "1",
)
	? [{}]
	: [{}, STRESS_ENV];
const outDir = mkdtempSync(join(tmpdir(), "mal-intl-relative-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
beforeAll(() => {
	pair = buildBackendPairFromOneProgramImage({
		fixture,
		name: "intl-relative-time",
		mainFile: HOST_MAIN,
		outDir,
		nodeEnabled: true,
		intlFeatures: ["relative-time-format"],
	});
});

describe.each(["compiled", "interpreted"] as const)(
	"%s RelativeTimeFormat",
	(backend) => {
		it("uses exact binary rounding before choosing numeric patterns", () => {
			const env = { RELATIVE_SCENARIO: "rounding", MAL_HOST_GC: "1" };
			for (const gcEnv of gcEnvironments)
				expect(runToStdout(pair[backend], { env: { ...env, ...gcEnv } }).trim()).toBe(
					"ok",
				);
		});

		it("formats large finite integers without truncating text or parts", () => {
			const cases = [1e20, 2 ** 127, 2 ** 128, 1e100, -(2 ** 400), Number.MAX_VALUE].map(
				(value) => [value, BigInt(Math.abs(value)).toString()],
			);
			const env = {
				RELATIVE_SCENARIO: "large",
				RELATIVE_LARGE_CASES: JSON.stringify(cases),
				MAL_HOST_GC: "1",
			};
			for (const gcEnv of gcEnvironments)
				expect(runToStdout(pair[backend], { env: { ...env, ...gcEnv } }).trim()).toBe(
					"ok",
				);
		});

		it.each([
			["parts", "preserves rounded localized numeric fields and automatic literals"],
			["protocol", "observes constructor and argument coercion order"],
		])("%s: %s", (scenario) => {
			const env = { RELATIVE_SCENARIO: scenario, MAL_HOST_GC: "1" };
			const oracle = execFileSync(process.execPath, ["--expose-gc", fixture], {
				encoding: "utf8",
				env: { ...process.env, ...env },
			});
			for (const gcEnv of gcEnvironments)
				expect(runToStdout(pair[backend], { env: { ...env, ...gcEnv } })).toBe(oracle);
		});
	},
);
