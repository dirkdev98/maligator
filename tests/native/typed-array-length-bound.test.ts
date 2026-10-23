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

const fixture = "tests/local/typed-array-length-bound.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-typed-length-bound-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function regionPlans(
	pair: ReturnType<typeof buildBackendPairFromOneProgramImage>,
	name: string,
) {
	const fn = pair.programImage.native.functions.find(
		(candidate) =>
			String.fromCharCode(
				...(pair.programImage.runtime.stringConstants[candidate.body.nameStringIndex] ??
					[]),
			) === name,
	);
	return fn?.storage?.numericLoopRegions ?? [];
}

describe("TypedArray loops bounded by their length", () => {
	it.each(["mutable", "locked"] as const)(
		"read and write fixed views directly while the length getter stays intrinsic (%s primordials)",
		(primordials) => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `typed-length-bound-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			for (const name of ["forwardDeltas", "trailingDeltas", "backwardPairs"])
				expect(
					regionPlans(pair, name).some(
						(plan) => plan.kind === "fixed-numeric" && plan.limitOffset !== 0,
					),
					name,
				).toBe(true);
			for (const name of ["scaleInPlace", "copyScaled"])
				expect(
					regionPlans(pair, name).some(
						(plan) =>
							plan.kind === "fixed-numeric" &&
							plan.boundObject !== undefined &&
							plan.views.some((view) => view.writable),
					),
					name,
				).toBe(true);
			const node = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
			// Locked primordials reject redefining the intrinsic getter.
			const expected =
				primordials === "locked"
					? node.replace('["replaced",1]', '["replaced","TypeError"]')
					: node;
			const measured = spawnSync(pair.compiled, [], {
				encoding: "utf8",
				timeout: 60000,
				env: { ...process.env, MAL_PERF_STATS: "1" },
			});
			expect(measured.status, measured.stderr).toBe(0);
			expect(measured.stdout).toBe(expected);
			expect(
				Number(
					measured.stderr.match(
						/\[perf-typed-array-region-stats\] admissions=(\d+)/,
					)?.[1] ?? 0,
				),
			).toBeGreaterThan(0);
			for (const binary of [pair.compiled, pair.interpreted])
				expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 60000 })).toBe(expected);
		},
		600000,
	);
});
