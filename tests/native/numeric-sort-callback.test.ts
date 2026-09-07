import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/numeric-sort-callback.mjs";
const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" }).trim();

describe("numeric sort callback specialization through both emitters", () => {
	it("preserves an overridden call property on the canonical sort builtin", () => {
		const overrideFixture = "tests/local/numeric-sort-call-override.mjs";
		const expectedOverride = execFileSync(process.execPath, [overrideFixture], {
			encoding: "utf8",
		}).trim();
		const pair = buildBackendPairFromOneProgramImage({
			fixture: overrideFixture,
			name: "numeric-sort-call-override",
			mainFile: HOST_MAIN,
			outDir: mkdtempSync(join(tmpdir(), "mal-numeric-sort-call-override-")),
			config: resolveBuildConfig({
				engine: { primordials: "mutable", eval: true, realms: true },
			}),
		});
		for (const binary of [pair.compiled, pair.interpreted])
			expect(runToStdout(binary, { env: STRESS_ENV }).trim()).toBe(expectedOverride);
	}, 600_000);

	it.each(["mutable", "locked"] as const)(
		"preserves ordering, callbacks, and fallback behavior with %s primordials",
		(primordials) => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `numeric-sort-callback-${primordials}`,
				mainFile: HOST_MAIN,
				environment: { ...process.env, MAL_PERF_STATS: "1" },
				outDir: mkdtempSync(join(tmpdir(), "mal-numeric-sort-callback-")),
				config: resolveBuildConfig({
					engine: { primordials, eval: primordials === "mutable" },
				}),
			});
			const run = spawnSync(pair.compiled, [], {
				encoding: "utf8",
				env: { ...process.env, MAL_PERF_STATS: "1" },
			});
			expect(run.status, run.stderr).toBe(0);
			expect(run.stdout.trim()).toBe(expected);
			const calls = run.stderr.match(/numeric_sort_callback_calls=(\d+)/);
			expect(calls, run.stderr).not.toBeNull();
			expect(Number(calls![1])).toBeGreaterThan(0);

			for (const binary of [pair.compiled, pair.interpreted]) {
				expect(runToStdout(binary).trim()).toBe(expected);
				expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 60_000 }).trim()).toBe(
					expected,
				);
			}
		},
		600_000,
	);
});
