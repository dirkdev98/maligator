import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
const fixture = "tests/local/string-span-dynamic-equality.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-span-equal-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
describe("string span strict equality with dynamic inputs", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves values, aliases, escapes and non-coercing comparison under %s primordials",
		(primordials) => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `span-equal-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
					surface: { node: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			const fn = pair.programImage.native.functions.find(
				(fn) =>
					String.fromCharCode(
						...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
					) === "compare",
			)!;
			const span = fn.specializations.find((region) => region.kind === "string-span");
			expect(
				span?.consumers.filter((consumer) => consumer.kind === "equal"),
			).toHaveLength(2);
			for (const mode of ["values", "fallback"]) {
				const env = { MAL_HOST_GC: "1", SPAN_EQUAL_KIND: mode };
				const expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
					encoding: "utf8",
					env: { ...process.env, ...env },
				});
				for (const binary of [pair.compiled, pair.interpreted])
					expect(
						runToStdout(binary, { env: { ...env, ...STRESS_ENV }, timeoutMs: 60000 }),
					).toBe(expected);
				const measured = spawnSync(pair.compiled, [], {
					encoding: "utf8",
					timeout: 60000,
					env: { ...process.env, ...env, MAL_PERF_STATS: "1" },
				});
				expect(measured.status, measured.stderr).toBe(0);
				expect(measured.stdout).toBe(expected);
				expect(
					Number(
						measured.stderr.match(/\[perf-string-span-equal-stats\] calls=(\d+)/)?.[1] ??
							0,
					),
				).toBeGreaterThan(0);
			}
		},
		600000,
	);
});
