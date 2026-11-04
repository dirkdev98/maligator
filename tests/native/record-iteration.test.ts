import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/record-iteration.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-record-iteration-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("nested record iteration", () => {
	let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
	beforeAll(() => {
		pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "record-iteration",
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
			config: resolveBuildConfig({
				engine: { eval: false, realms: false },
				surface: { node: true },
			}),
		});
	});
	it.each([
		["ordinary", "updates nested fields and reduces active records"],
		["aliases", "observes earlier writes through nested aliases"],
		["cycles", "preserves cycles in the record graph"],
		["nullish", "uses defaults for null and undefined profiles"],
		["getters", "runs late getters after each update exactly once"],
		["coercion", "coerces late values after each update exactly once"],
		["proxy", "preserves proxy access order"],
		["inherited", "preserves inherited reads and fresh own writes"],
		["frozen", "throws at the original nonwritable store"],
		["specialNumbers", "preserves NaN, infinities and signed zero"],
		["changedKinds", "allows a carried value to change kind through fallback"],
		["sparse", "throws on the original missing element"],
	])("%s: %s", (scenario) => {
		const env = { RECORD_ITERATION_CASE: scenario };
		const expected = execFileSync(process.execPath, [fixture], {
			encoding: "utf8",
			env: { ...process.env, ...env },
		});
		for (const binary of [pair.compiled, pair.interpreted])
			expect(runToStdout(binary, { env })).toBe(expected);
	});
	it.each(["ordinary", "getters"])(
		"executes the preflighted %s record body",
		(scenario) => {
			const run = spawnSync(pair.compiled, [], {
				encoding: "utf8",
				env: { ...process.env, MAL_PERF_STATS: "1", RECORD_ITERATION_CASE: scenario },
			});
			expect(run.status, run.stderr).toBe(0);
			expect(
				Number(run.stderr.match(/record_iteration_region_admissions=(\d+)/)?.[1] ?? 0),
			).toBeGreaterThan(0);
		},
	);
	it.each(["ordinary", "aliases", "getters"])(
		"keeps %s records rooted at iteration boundaries",
		(scenario) => {
			const env = { ...STRESS_ENV, RECORD_ITERATION_CASE: scenario };
			const expected = execFileSync(process.execPath, [fixture], {
				encoding: "utf8",
				env: { ...process.env, RECORD_ITERATION_CASE: scenario },
			});
			for (const binary of [pair.compiled, pair.interpreted])
				expect(runToStdout(binary, { env })).toBe(expected);
		},
	);
});
