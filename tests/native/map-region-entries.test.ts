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
	resolveHarnessExecutionInvocation,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/map-region-entries.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-map-region-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("region-local Map entries", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves keys, reference values, GC and mutations across branches, handlers and loop generations under %s primordials",
		(primordials) => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `map-region-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
					surface: { node: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			expect(
				pair.programImage.native.functions.some(
					(fn) => fn.storage!.mapEntries.length > 0,
				),
			).toBe(true);
			for (const name of [
				"updateReferences",
				"updateAfterHandler",
				"updateAcrossControl",
				"updateLoopHints",
			]) {
				const fn = pair.programImage.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
								[]),
						) === name,
				)!;
				expect(fn.storage!.mapEntries.length, name).toBeGreaterThan(0);
				if (name === "updateAfterHandler" || name === "updateAcrossControl")
					expect(fn.body.handlers.length).toBeGreaterThan(0);
			}
			for (const mode of ["numeric", "references", "handler", "control"]) {
				const env = {
					MAL_HOST_GC: "1",
					MAL_MAP_MUTABLE: primordials,
					MAL_MAP_REGION_MODE: mode,
				};
				const expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
					encoding: "utf8",
					env: { ...process.env, ...env },
				});
				for (const binary of [pair.compiled, pair.interpreted])
					for (const stress of [{}, STRESS_ENV])
						expect(
							runToStdout(binary, {
								env: { ...env, ...stress },
								timeoutMs: 60_000,
							}),
							`${primordials}/${mode}/${binary}/${JSON.stringify(stress)}`,
						).toBe(expected);
				const invocation = resolveHarnessExecutionInvocation(pair.compiled);
				const measured = spawnSync(invocation.executable, invocation.args, {
					encoding: "utf8",
					timeout: 60_000,
					env: {
						...process.env,
						...env,
						MAL_PERF_STATS: "1",
					},
				});
				expect(measured.status, `${primordials}/${mode}: ${measured.stderr}`).toBe(0);
				expect(measured.stdout).toBe(expected);
				const stats = measured.stderr.match(
					/\[perf-map-region-stats\] hits=(\d+) misses=(\d+)/,
				);
				expect(stats).not.toBeNull();
				expect(Number(stats![1]), `${primordials}/${mode}: hits`).toBeGreaterThan(0);
				expect(Number(stats![2]), `${primordials}/${mode}: misses`).toBeGreaterThan(0);
			}
		},
		600_000,
	);
});
