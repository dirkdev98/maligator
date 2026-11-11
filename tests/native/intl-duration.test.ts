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

const fixture = "tests/local/intl-duration.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-intl-duration-"));
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
		name: "intl-duration",
		mainFile: HOST_MAIN,
		outDir,
		nodeEnabled: true,
		intlFeatures: ["duration-format"],
	});
});
describe.each(["compiled", "interpreted"] as const)("%s DurationFormat", (backend) => {
	it("validates exact aggregate bounds and preserves valid wide subsecond fields", () => {
		for (const gcEnv of gcEnvironments)
			expect(
				runToStdout(pair[backend], {
					env: { DURATION_SCENARIO: "bounds", ...gcEnv },
				}).trim(),
			).toBe("ok");
	});
	it("preserves pinned unit-list separators and field attribution", () => {
		for (const gcEnv of gcEnvironments)
			expect(
				runToStdout(pair[backend], {
					env: { DURATION_SCENARIO: "pinned_parts", ...gcEnv },
				}).trim(),
			).toBe("ok");
	});
	it.each(["protocol", "text", "parts"])(
		"observes %s through the public formatter",
		(scenario) => {
			const env = { DURATION_SCENARIO: scenario, MAL_HOST_GC: "1" };
			const expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
				encoding: "utf8",
				maxBuffer: 8 * 1024 * 1024,
				env: { ...process.env, ...env },
			});
			for (const gcEnv of gcEnvironments)
				expect(runToStdout(pair[backend], { env: { ...env, ...gcEnv } })).toBe(expected);
		},
	);
});
