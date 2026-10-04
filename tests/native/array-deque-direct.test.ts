import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	assertResultPass,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-array-deque-direct-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function field(line: string, name: string): number {
	return Number(line.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)`))?.[1] ?? 0);
}

describe("direct Array pop, shift and unshift", () => {
	let compiled: string;
	let interpreted: string;
	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/array-deque-direct.js",
			name: "array-deque-direct",
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		}));
	}, 600_000);

	for (const mode of ["compiled", "interpreted"] as const) {
		it(`preserves Array semantics in ${mode} mode`, () => {
			const binary = mode === "compiled" ? compiled : interpreted;
			assertResultPass(runToStdout(binary));
			assertResultPass(runToStdout(binary, { env: STRESS_ENV }));
		});
	}

	it("applies dense deque operations without a call frame", () => {
		const result = spawnSync(compiled, [], {
			env: { ...process.env, MAL_PERF_STATS: "1" },
			encoding: "utf-8",
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		assertResultPass(result.stdout);
		const line = result.stderr
			.split("\n")
			.find((candidate) => candidate.startsWith("[perf-array-stats]"));
		expect(line).toBeDefined();
		// The 4,096-round loop performs four pop/shift/unshift operations per round.
		expect(field(line ?? "", "deque_direct_hits")).toBeGreaterThanOrEqual(4 * 4096);
	});
});
