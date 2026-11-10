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

const fixture = "tests/local/intl-list-format.js";
const gcEnvironments = ["MAL_ASAN", "MAL_UBSAN", "MAL_TSAN"].some(
	(key) => process.env[key] === "1",
)
	? [{}]
	: [{}, STRESS_ENV];
const outDir = mkdtempSync(join(tmpdir(), "mal-intl-list-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
beforeAll(() => {
	pair = buildBackendPairFromOneProgramImage({
		fixture,
		name: "intl-list-format",
		mainFile: HOST_MAIN,
		outDir,
		nodeEnabled: true,
		intlFeatures: ["list-format"],
	});
});

describe.each(["compiled", "interpreted"] as const)("%s ListFormat", (backend) => {
	it("retains empty element records required by CreatePartsFromList", () => {
		const env = { LIST_SCENARIO: "empty", MAL_HOST_GC: "1" };
		for (const gcEnv of gcEnvironments)
			expect(runToStdout(pair[backend], { env: { ...env, ...gcEnv } }).trim()).toBe("ok");
	});

	it("selects Hebrew conjunctions from the following element", () => {
		const env = { LIST_SCENARIO: "hebrew", MAL_HOST_GC: "1" };
		for (const gcEnv of gcEnvironments)
			expect(runToStdout(pair[backend], { env: { ...env, ...gcEnv } }).trim()).toBe("ok");
	});

	it.each([
		["text", "preserves Unicode elements and localized parts"],
		["protocol", "observes constructor and iterator effects"],
	])("%s: %s", (scenario) => {
		const env = { LIST_SCENARIO: scenario, MAL_HOST_GC: "1" };
		const oracle = execFileSync(process.execPath, ["--expose-gc", fixture], {
			encoding: "utf8",
			env: { ...process.env, ...env },
			maxBuffer: 8 * 1024 * 1024,
		});
		for (const gcEnv of gcEnvironments)
			expect(runToStdout(pair[backend], { env: { ...env, ...gcEnv } })).toBe(oracle);
	});
});
