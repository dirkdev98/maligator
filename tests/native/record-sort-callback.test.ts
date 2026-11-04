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

const fixture = "tests/local/record-sort-callback.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-record-sort-callback-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("record sort callback kernels", () => {
	let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
	beforeAll(() => {
		pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "record-sort-callback",
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
			config: resolveBuildConfig({
				engine: { eval: false, realms: false },
				surface: { node: true },
			}),
		});
	});

	it.each([
		{ scenario: "stable", behavior: "preserves ties and the copy boundary" },
		{
			scenario: "mixedShapes",
			behavior: "sorts numeric fields from different own layouts",
		},
		{ scenario: "frozen", behavior: "reads frozen numeric records" },
		{ scenario: "identities", behavior: "preserves repeated record identities" },
		{
			scenario: "specialNumbers",
			behavior: "matches generic comparisons for NaN, infinities and signed zero",
		},
		{ scenario: "getters", behavior: "falls back without speculative getter calls" },
		{ scenario: "proxies", behavior: "preserves proxy property access" },
		{ scenario: "inherited", behavior: "falls back for inherited fields" },
		{ scenario: "coercion", behavior: "preserves comparator coercion" },
		{
			scenario: "collection",
			behavior: "observes collection getters before capturing numeric fields",
		},
		{ scenario: "mutation", behavior: "retains comparator mutations" },
		{
			scenario: "exception",
			behavior: "propagates comparison exceptions before writeback",
		},
		{ scenario: "detached", behavior: "supports detached sort and toSorted calls" },
		{ scenario: "override", behavior: "honors replaced sort methods" },
		{ scenario: "sparse", behavior: "preserves undefined elements and holes" },
	])("$behavior", ({ scenario }) => {
		const env = { RECORD_SORT_CASE: scenario };
		const expected = execFileSync(process.execPath, [fixture], {
			encoding: "utf8",
			env: { ...process.env, ...env },
		});
		for (const binary of [pair.compiled, pair.interpreted])
			expect(runToStdout(binary, { env })).toBe(expected);
	});

	it.each(["inPlace", "copy"])("executes the guarded %s record kernel", (scenario) => {
		const run = spawnSync(pair.compiled, [], {
			encoding: "utf8",
			env: { ...process.env, MAL_PERF_STATS: "1", RECORD_SORT_CASE: scenario },
		});
		expect(run.status, run.stderr).toBe(0);
		const counter = run.stderr.match(/record_sort_kernel_runs=(\d+)/);
		expect(counter, run.stderr).not.toBeNull();
		expect(Number(counter![1])).toBeGreaterThan(0);
	});

	it.each(["stable", "getters", "collection"])(
		"keeps records rooted through %s collection and sorting",
		(scenario) => {
			const env = { ...STRESS_ENV, RECORD_SORT_CASE: scenario };
			const expected = execFileSync(process.execPath, [fixture], {
				encoding: "utf8",
				env: { ...process.env, RECORD_SORT_CASE: scenario },
			});
			for (const binary of [pair.compiled, pair.interpreted])
				expect(runToStdout(binary, { env })).toBe(expected);
		},
	);
});
