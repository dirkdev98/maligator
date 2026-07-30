import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	assertExactLines,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/array-push-direct.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-array-push-direct-"));

function field(line: string, name: string): number {
	return Number(line.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)`))?.[1] ?? 0);
}

describe("guarded direct Array.prototype.push", () => {
	let compiled: string;
	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture,
			name: "array-push-direct",
			compiled: true,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
	}, 600_000);

	it("preserves overrides, mutation, exceptional fallbacks, and return values", () => {
		assertExactLines(runToStdout(compiled), ["array-push-direct PASS"]);
	});

	it("keeps appended values live under GC stress", () => {
		assertExactLines(runToStdout(compiled, { env: STRESS_ENV }), [
			"array-push-direct PASS",
		]);
	});

	it("takes both guarded dense hits and unchanged generic fallbacks", () => {
		const result = spawnSync(compiled, [], {
			env: { ...process.env, MAL_PERF_STATS: "1" },
			encoding: "utf-8",
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		const line = result.stderr
			.split("\n")
			.find((candidate) => candidate.startsWith("[perf-array-stats]"));
		expect(line).toBeDefined();
		expect(field(line ?? "", "push_direct_hits")).toBeGreaterThan(3000);
		expect(field(line ?? "", "push_direct_fallbacks")).toBeGreaterThanOrEqual(8);
	});
});
