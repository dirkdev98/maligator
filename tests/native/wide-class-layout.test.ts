import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	buildNativeBinary,
	resolveHarnessExecutionInvocation,
	runToStdout,
	scaledNativeRunTimeoutMs,
	STRESS_ENV,
} from "../../src/test-harness.ts";

describe("class layouts wider than the ordinary shape bound", () => {
	const fixture = "tests/local/wide-class-layout.js";
	const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-wide-class-layout-"));
	afterAll(() => rmSync(outDir, { recursive: true, force: true }));

	it.each([true, false])(
		"keep fields, brands and growth past the reservation correct (compiled: %s)",
		(compiled) => {
			const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
			const binary = buildNativeBinary({
				fixture,
				name: `wide-class-layout-${compiled ? "c" : "i"}`,
				compiled,
				outDir,
			});
			expect(runToStdout(binary)).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 120_000 })).toBe(expected);
		},
		600_000,
	);

	it("spill private elements only from the instance that outgrows its reservation", () => {
		const binary = buildNativeBinary({
			fixture,
			name: "wide-class-layout-perf",
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		const invocation = resolveHarnessExecutionInvocation(binary);
		const result = spawnSync(invocation.executable, invocation.args, {
			env: { ...process.env, MAL_PERF_STATS: "1" },
			encoding: "utf8",
			timeout: scaledNativeRunTimeoutMs(120_000),
		});
		if (result.error !== undefined) throw result.error;
		expect(result.status, result.stderr).toBe(0);
		const evictions = result.stderr.match(
			/^\[perf-shape-transition-stats\].*\bprivate_evictions=(\d+)/m,
		)?.[1];
		expect(Number(evictions)).toBe(1);
	}, 600_000);
});
