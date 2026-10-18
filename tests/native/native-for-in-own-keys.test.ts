import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const expected = ["native-for-in-own-keys PASS"];
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-for-in-own-keys-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function ownKeySnapshots(stderr: string): number {
	const line = stderr
		.split("\n")
		.find((candidate) => candidate.startsWith("[perf-for-in-stats]"));
	return Number(line?.match(/(?:^|\s)own_key_snapshots=([0-9]+)/)?.[1] ?? -1);
}

describe("native for-in over silent prototype chains", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/native-for-in-own-keys.js",
			name: "native-for-in-own-keys",
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		}));
	}, 600_000);

	it("enumerates own keys directly when no prototype has an enumerable key", () => {
		const result = spawnSync(compiled, [], {
			env: { ...process.env, MAL_PERF_STATS: "1" },
			encoding: "utf-8",
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		assertExactLines(result.stdout, expected);
		expect(ownKeySnapshots(result.stderr)).toBeGreaterThan(0);
	});

	it("observes prototype changes between enumerations under collection stress", () => {
		assertExactLines(runToStdout(compiled, { env: STRESS_ENV }), expected);
	});

	it("matches the interpreted semantics", () => {
		assertExactLines(runToStdout(interpreted), expected);
	});
});
