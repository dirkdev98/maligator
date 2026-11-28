import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/object-growth.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-object-growth-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("object slot growth", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "object-growth",
			mainFile: HOST_MAIN,
			outDir,
			config: resolveBuildConfig({}),
		}));
	}, 600_000);

	it.each([
		["fields", "preserves property values across multiple storage sizes"],
		[
			"dictionary",
			"preserves order and descriptors when grown fields enter a dictionary",
		],
		["churn", "preserves surviving object values amid short-lived growing objects"],
		["freeze", "preserves frozen descriptors after growth"],
	])("%s %s", (scenario) => {
		const env = { OBJECT_GROWTH_CASE: scenario, MAL_HOST_GC: "1" };
		const expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
			encoding: "utf8",
			env: { ...process.env, ...env },
		});
		for (const [backend, binary] of Object.entries({ compiled, interpreted })) {
			for (const stress of [{}, STRESS_ENV]) {
				expect(
					runToStdout(binary, { env: { ...env, ...stress, MAL_GC_AT_EXIT: "1" } }),
					`${backend}, GC stress ${stress.MAL_GC_STRESS ?? "off"}`,
				).toBe(expected);
			}
		}
	});
});
