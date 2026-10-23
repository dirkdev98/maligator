import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	assertPassLine,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-entry-pair-parameters-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function counter(line: string, name: string): number {
	const match = new RegExp(`\\b${name}=(\\d+)`).exec(line);
	if (match === null) throw new Error(`missing ${name} in ${line}`);
	return Number(match[1]);
}

describe("for-of pair destructuring over parameter iterables", () => {
	let compiled: string;
	let interpreted: string;
	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/entry-pair-parameters.js",
			name: "entry-pair-parameters",
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		}));
	}, 600_000);

	it("borrows collection entries and dense array pairs without materializing them", () => {
		const result = spawnSync(compiled, [], {
			env: { ...process.env, MAL_HOST_GC: "1", MAL_PERF_STATS: "1" },
			encoding: "utf-8",
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		assertPassLine(result.stdout, "entry-pair-parameters");
		const line =
			result.stderr
				.split("\n")
				.find((candidate) => candidate.startsWith("[perf-map-stats]")) ?? "";
		const retainedRounds = 4 * (64 + 64);
		const repeatedSmallPairs = 200 * 2;
		expect(counter(line, "entry_pair_hits")).toBeGreaterThanOrEqual(
			retainedRounds + repeatedSmallPairs,
		);
		expect(counter(line, "deferred_array_iterators")).toBeGreaterThan(200);
	});

	it("preserves semantics under compiled GC stress", () => {
		assertPassLine(runToStdout(compiled, { env: STRESS_ENV }), "entry-pair-parameters");
	});

	it("preserves interpreted semantics", () => {
		assertPassLine(runToStdout(interpreted), "entry-pair-parameters");
		assertPassLine(
			runToStdout(interpreted, { env: STRESS_ENV }),
			"entry-pair-parameters",
		);
	});
});
