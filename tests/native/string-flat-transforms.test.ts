import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BackendPairResult } from "../../src/test-harness.ts";
import {
	buildBackendPairFromOneProgramImage,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/string-flat-transforms.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-string-flat-transforms-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("String case mapping, replacement, splitting, trimming and search", () => {
	let pair: BackendPairResult;
	let instrumented: string;
	let expected: string;
	beforeAll(() => {
		pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "string-flat-transforms",
			outDir,
		});
		instrumented = buildNativeBinary({
			fixture,
			name: "string-flat-transforms-perf",
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	}, 600_000);

	it.each(["compiled", "interpreted"] as const)(
		"matches Node across Latin-1, two-byte, sliced and concatenated strings when %s",
		(backend) => {
			expect(runToStdout(pair[backend])).toBe(expected);
		},
	);

	it("keeps every result live under GC stress", () => {
		expect(runToStdout(pair.compiled, { env: STRESS_ENV })).toBe(expected);
	});

	it("maps, replaces and splits one-leaf strings without the growing text buffer", () => {
		const result = spawnSync(instrumented, [], {
			encoding: "utf8",
			timeout: 60_000,
			env: { ...process.env, MAL_PERF_STATS: "1" },
		});
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe(expected);
		const counts = result.stderr.match(
			/\[perf-string-flat-stats\] case_fixed=(\d+) replace_flat=(\d+) split_flat=(\d+)/,
		);
		expect(counts, result.stderr).not.toBeNull();
		for (const count of counts!.slice(1)) expect(Number(count)).toBeGreaterThan(0);
	});
});
