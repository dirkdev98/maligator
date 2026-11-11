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

const fixture = "tests/local/intl-number.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-intl-number-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
const gcEnvironments = ["MAL_ASAN", "MAL_UBSAN", "MAL_TSAN"].some(
	(key) => process.env[key] === "1",
)
	? [{}]
	: [{}, STRESS_ENV];
let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
beforeAll(() => {
	pair = buildBackendPairFromOneProgramImage({
		fixture,
		name: "intl-number",
		mainFile: HOST_MAIN,
		outDir,
		nodeEnabled: true,
		intlFeatures: ["number-format"],
	});
});
describe.each(["compiled", "interpreted"] as const)("%s NumberFormat", (backend) => {
	it("retains exact decimal and radix strings through rounding", () => {
		for (const gcEnv of gcEnvironments)
			expect(
				runToStdout(pair[backend], {
					env: { NUMBER_SCENARIO: "exact", ...gcEnv },
				}).trim(),
			).toBe("ok");
	});
	it.each(["protocol", "parts"])(
		"observes %s through the public formatter",
		(scenario) => {
			const env = { NUMBER_SCENARIO: scenario, MAL_HOST_GC: "1" };
			const expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
				encoding: "utf8",
				env: { ...process.env, ...env },
			});
			for (const gcEnv of gcEnvironments)
				expect(runToStdout(pair[backend], { env: { ...env, ...gcEnv } })).toBe(expected);
		},
	);
});
