import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/read-accessor-regions.mjs";
const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" }).trim();

describe("admitted class read-accessor regions", () => {
	it("preserves overrides, getters, defaults, failures, and retirement in both backends", () => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "read-accessor-regions",
		});
		for (const binary of [pair.compiled, pair.interpreted]) {
			expect(runToStdout(binary).trim()).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV }).trim()).toBe(expected);
		}
	}, 600_000);
});
