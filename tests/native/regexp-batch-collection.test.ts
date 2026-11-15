import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	resolveHarnessExecutionInvocation,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/regexp-batch-collection.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-regexp-batch-collection-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("RegExp match collection", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves replacement, captures and final matcher state under %s primordials",
		(primordials) => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `regexp-batch-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
			for (const target of [pair.compiled, pair.interpreted]) {
				const invocation = resolveHarnessExecutionInvocation(target);
				const result = spawnSync(invocation.executable, invocation.args, {
					encoding: "utf8",
					timeout: 60_000,
					env: {
						...process.env,
						...STRESS_ENV,
						MAL_HOST_GC: "1",
						MAL_PERF_STATS: "1",
					},
				});
				expect(result.status, result.stderr).toBe(0);
				expect(result.stdout).toBe(expected);
				const counts = result.stderr.match(/collect_batches=(\d+) collect_matches=(\d+)/);
				expect(counts, result.stderr).not.toBeNull();
				for (const count of counts!.slice(1)) expect(Number(count)).toBeGreaterThan(0);
			}
		},
	);
});
