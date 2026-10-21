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

describe("class layout guards", () => {
	const fixture = "tests/local/class-layout-guards.js";
	const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-class-layout-guards-"));
	afterAll(() => rmSync(outDir, { recursive: true, force: true }));

	it.each([true, false])(
		"fall back whenever an instance or its prototype chain leaves the layout (compiled: %s)",
		(compiled) => {
			const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
			const binary = buildNativeBinary({
				fixture,
				name: `class-layout-guards-${compiled ? "c" : "i"}`,
				compiled,
				outDir,
			});
			expect(runToStdout(binary)).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 120_000 })).toBe(expected);
		},
		600_000,
	);

	it("serve field and method sites from admitted class cells", () => {
		const binary = buildNativeBinary({
			fixture,
			name: "class-layout-guards-perf",
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
		const stats = /^\[perf-class-layout-stats\] (.*)$/m.exec(result.stderr)?.[1] ?? "";
		const counter = (name: string) =>
			Number(new RegExp(`\\b${name}=(\\d+)`).exec(stats)?.[1]);
		expect(counter("admissions")).toBeGreaterThan(0);
		expect(counter("slot_hits")).toBeGreaterThan(0);
		expect(counter("method_hits")).toBeGreaterThan(0);
	}, 600_000);
});
