import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/array-iteration-integers.cjs";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-array-iteration-integers-"));

// The fixture iterates Arrays only through for-of, so these back edges are its regions'.
function integerBackEdges(stderr: string): number {
	const match = /\binteger-back-edges=(\d+)/.exec(stderr);
	if (match === null) throw new Error(`missing integer-back-edges in ${stderr}`);
	return Number(match[1]);
}

describe("for-of integer arithmetic over Arrays", () => {
	afterAll(() => rmSync(outDir, { recursive: true, force: true }));
	let compiled: string;
	let interpreted: string;
	let expected: string;
	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "array-iteration-integers",
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		}));
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	}, 600_000);

	it("runs integer elements in integer locals and restarts the rest in Numbers", () => {
		const result = spawnSync(compiled, [], {
			encoding: "utf8",
			timeout: 60_000,
			env: { ...process.env, MAL_PERF_STATS: "1" },
		});
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe(expected);
		expect(integerBackEdges(result.stderr)).toBeGreaterThan(0);
	});

	it("matches Node under compiled GC stress", () => {
		expect(runToStdout(compiled, { env: STRESS_ENV, timeoutMs: 120_000 })).toBe(expected);
	});

	it("matches Node when interpreted", () => {
		expect(runToStdout(interpreted, { timeoutMs: 60_000 })).toBe(expected);
	});
});
