import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-checked-array-integers-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

it.each(["mutable", "locked"] as const)(
	"preserves Array writes and Number fallback with %s primordials",
	(primordials) => {
		const fixture = "tests/local/checked-array-integers.cjs";
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: `checked-array-integers-${primordials}`,
			outDir,
			config: resolveBuildConfig({ engine: { primordials } }),
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		const measured = spawnSync(pair.compiled, [], {
			encoding: "utf8",
			timeout: 60000,
			env: { ...process.env, MAL_PERF_STATS: "1" },
		});
		expect(measured.status, measured.stderr).toBe(0);
		expect(measured.stdout).toBe(expected);
		expect(
			Number(measured.stderr.match(/integer-back-edges=(\d+)/)?.[1] ?? 0),
		).toBeGreaterThan(0);
		for (const binary of [pair.compiled, pair.interpreted])
			expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 60000 })).toBe(expected);
	},
	300000,
);
