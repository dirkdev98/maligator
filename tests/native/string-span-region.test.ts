import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	buildNativeBinaryResult,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/string-span-region.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-string-span-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("composable string spans", () => {
	it("retains captured code-point method realms during coercing fallback", () => {
		const realmFixture = "tests/local/string-span-code-points-realms.js";
		const expected = execFileSync(
			process.execPath,
			[
				"-e",
				`globalThis.$262 = { createRealm() { return { global: require("node:vm").runInNewContext("globalThis") }; } }; require(${JSON.stringify(path.resolve(realmFixture))});`,
			],
			{ encoding: "utf8" },
		);
		for (const compiled of [true, false]) {
			const built = buildNativeBinaryResult({
				fixture: realmFixture,
				name: `span-code-points-realms-${compiled}`,
				compiled,
				mainFile: "runtime/test262_main.c",
				outDir,
				config: resolveBuildConfig({ engine: { primordials: "mutable", realms: true } }),
			});
			for (const stress of [{}, STRESS_ENV])
				expect(
					runToStdout(built.binaryPath, {
						env: { MAL_TEST262: "1", MAL_HOST_GC: "1", ...stress },
						timeoutMs: 60_000,
					}),
				).toBe(expected);
		}
	}, 600_000);
	it.each(["mutable", "locked"] as const)(
		"preserves projections, escaping branches, effects, and rooted sources under %s primordials",
		(primordials) => {
			const expected = execFileSync(process.execPath, [fixture], {
				encoding: "utf8",
				env: { ...process.env, MAL_STRING_SPAN_MUTABLE: primordials },
			});
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `string-span-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
					surface: { node: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			expect(
				pair.programImage.native.functions
					.flatMap((fn) => fn.specializations)
					.filter((region) => region.kind === "string-span").length,
			).toBeGreaterThan(0);
			expect(
				pair.programImage.native.functions.some((fn) =>
					fn.specializations.some(
						(region) =>
							region.kind === "string-span" && region.rangeOperation === "substring",
					),
				),
			).toBe(true);
			for (const binary of [pair.compiled, pair.interpreted])
				for (const stress of [{}, STRESS_ENV])
					expect(
						runToStdout(binary, {
							env: { MAL_HOST_GC: "1", MAL_STRING_SPAN_MUTABLE: primordials, ...stress },
							timeoutMs: 60_000,
						}),
					).toBe(expected);
			const measured = spawnSync(pair.compiled, [], {
				encoding: "utf8",
				timeout: 60_000,
				env: {
					...process.env,
					MAL_HOST_GC: "1",
					MAL_PERF_STATS: "1",
					MAL_STRING_SPAN_MUTABLE: primordials,
				},
			});
			expect(measured.status, measured.stderr).toBe(0);
			expect(measured.stdout).toBe(expected);
			const stats = measured.stderr.match(
				/\[perf-string-span-stats\] admissions=(\d+) projections=(\d+) materializations=(\d+)/,
			);
			expect(stats).not.toBeNull();
			expect(Number(stats![1])).toBeGreaterThan(0);
			expect(Number(stats![2])).toBeGreaterThan(Number(stats![1]));
			expect(Number(stats![3])).toBeGreaterThan(0);
			expect(Number(stats![3])).toBeLessThan(Number(stats![1]));
			const characters = measured.stderr.match(
				/\[perf-string-span-character-stats\] reads=(\d+)/,
			);
			expect(characters).not.toBeNull();
			expect(Number(characters![1])).toBeGreaterThan(0);
			const codePoints = measured.stderr.match(
				/\[perf-string-span-code-point-stats\] reads=(\d+)/,
			);
			expect(codePoints).not.toBeNull();
			expect(Number(codePoints![1])).toBeGreaterThan(0);
			const substring = measured.stderr.match(
				/\[perf-string-span-substring-stats\] admissions=(\d+)/,
			);
			expect(substring).not.toBeNull();
			expect(Number(substring![1])).toBeGreaterThan(0);
		},
		600_000,
	);
});
