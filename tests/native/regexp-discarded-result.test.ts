import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/regexp-discarded-result.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-regexp-discarded-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("discarded regexp exec results", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves exec effects and captured callees under %s primordials",
		(primordials) => {
			const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `regexp-discarded-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
					surface: { node: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			for (const name of ["discard", "discardLiteral"]) {
				const callback = pair.programImage.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
								[]),
						) === name,
				);
				expect(
					callback?.specializations.some(
						(region) =>
							region.kind === "regexp-exec-projection" && region.loads.length === 0,
					),
				).toBe(true);
			}
			for (const binary of [pair.compiled, pair.interpreted]) {
				for (const stress of [{}, STRESS_ENV]) {
					expect(runToStdout(binary, { env: stress, timeoutMs: 60_000 })).toBe(expected);
				}
			}
			const measured = spawnSync(pair.compiled, [], {
				encoding: "utf8",
				timeout: 60_000,
				env: { ...process.env, MAL_PERF_STATS: "1" },
			});
			expect(measured.status, measured.stderr).toBe(0);
			expect(measured.stdout).toBe(expected);
			const elisions = measured.stderr.match(/result_elisions=(\d+)/);
			expect(elisions).not.toBeNull();
			expect(Number(elisions![1])).toBeGreaterThan(0);
		},
	);
});
