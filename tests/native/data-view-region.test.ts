import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	resolveHarnessExecutionInvocation,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/data-view-region.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-data-view-region-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

// Every counted accessor loop in the fixture: the per-type kernels and the combined ones.
const accessorLoops = [
	...readFileSync(fixture, "utf8").matchAll(
		/^function ((?:write|read)\w+|mixed|descending)\(/gm,
	),
].map(([, name]) => name!);

describe.each(["locked", "mutable"] as const)(
	"DataView accessor loops as numeric regions with %s primordials",
	(primordials) => {
		let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
		let expected: string;

		beforeAll(() => {
			expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
			pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `data-view-region-${primordials}`,
				outDir,
				config: resolveBuildConfig({ engine: { primordials } }),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
		}, 600_000);

		it("plans every counted accessor loop as a region over its DataView", () => {
			const planned = pair.programImage.native.functions
				.filter((fn) =>
					fn.storage?.numericLoopRegions.some(
						(region) =>
							region.kind === "fixed-numeric" &&
							region.views.some((view) => view.byteScale !== undefined),
					),
				)
				.map((fn) =>
					String.fromCharCode(
						...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
					),
				);
			expect(planned.toSorted()).toEqual(accessorLoops.toSorted());
		});

		it("admits intact DataViews at run time", () => {
			const invocation = resolveHarnessExecutionInvocation(pair.compiled);
			const run = spawnSync(invocation.executable, invocation.args, {
				encoding: "utf8",
				timeout: 60_000,
				env: { ...process.env, MAL_PERF_STATS: "1" },
			});
			expect(run.status, run.stderr).toBe(0);
			const views = run.stderr.match(/\[perf-data-view-region-stats\] views=(\d+)/)?.[1];
			expect(Number(views ?? 0)).toBeGreaterThan(0);
		});

		it("matches Node for every type, byte order, window and declined view", () => {
			for (const binary of [pair.compiled, pair.interpreted])
				expect(runToStdout(binary)).toBe(expected);
		});

		it("matches Node across GC stress", () => {
			expect(runToStdout(pair.compiled, { env: STRESS_ENV, timeoutMs: 120_000 })).toBe(
				expected,
			);
		});
	},
);
