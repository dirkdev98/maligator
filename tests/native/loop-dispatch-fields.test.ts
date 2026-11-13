import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	resolveHarnessExecutionInvocation,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/loop-dispatch-fields.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-loop-dispatch-fields-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });

function counters(stderr: string, line: string): (name: string) => number {
	const stats = new RegExp(`^\\[${line}\\] (.*)$`, "m").exec(stderr)?.[1] ?? "";
	return (name) => Number(new RegExp(`\\b${name}=(\\d+)`).exec(stats)?.[1]);
}

describe("numeric loops over guessed methods and class instance fields", () => {
	it.each([
		["locked", {}],
		["mutable", { engine: { primordials: "mutable" as const } }],
	])(
		"call each receiver's own method and read each element's own field with %s primordials",
		(name, config) => {
			const { compiled, interpreted } = buildBackendPairFromOneProgramImage({
				fixture,
				name: `loop-dispatch-fields-${name}`,
				config: resolveBuildConfig(config),
				outDir,
			});
			for (const binary of [compiled, interpreted]) {
				expect(runToStdout(binary)).toBe(expected);
				expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 120_000 })).toBe(
					expected,
				);
			}
		},
		600_000,
	);

	it("runs the warm loops as regions that read class fields through the class cells", () => {
		const { compiled } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "loop-dispatch-fields-perf",
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		const invocation = resolveHarnessExecutionInvocation(compiled);
		const result = spawnSync(invocation.executable, invocation.args, {
			env: { ...process.env, MAL_PERF_STATS: "1" },
			encoding: "utf8",
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(result.stdout).toBe(expected);
		const loops = Number(result.stdout.match(/\bloops=(\d+)/)?.[1]);
		const items = Number(result.stdout.match(/\bitems=(\d+)/)?.[1]);
		const invariant = counters(result.stderr, "perf-loop-invariant-stats");
		const arrays = counters(result.stderr, "perf-dense-array-region-stats");
		const layouts = counters(result.stderr, "perf-class-layout-stats");
		// Each warm round runs seven loops behind callee checks or invariant loads, and
		// three loops over the class instances.
		expect(invariant("admissions")).toBeGreaterThanOrEqual(7 * loops);
		expect(arrays("admissions")).toBeGreaterThanOrEqual(3 * loops);
		// Outside a region, every field read of every element is a class cell hit.
		expect(layouts("slot_hits")).toBeLessThan(loops * items);
	}, 600_000);
});
