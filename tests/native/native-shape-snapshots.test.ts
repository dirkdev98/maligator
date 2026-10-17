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

const expected = ["native-shape-snapshots PASS"];
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-shape-snapshots-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function snapshotHits(stderr: string): number {
	const line = stderr
		.split("\n")
		.find((candidate) => candidate.startsWith("[perf-ic-stats]"));
	return Number(line?.match(/(?:^|\s)snapshot_hits=([0-9]+)/)?.[1] ?? -1);
}

describe("native number-record shape snapshots", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/native-shape-snapshots.js",
			name: "native-shape-snapshots",
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		}));
	}, 600_000);

	it("answers loop record fields from their frame-local shape rows", () => {
		const result = spawnSync(compiled, [], {
			env: { ...process.env, MAL_PERF_STATS: "1" },
			encoding: "utf-8",
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		assertExactLines(result.stdout, expected);
		expect(snapshotHits(result.stderr)).toBeGreaterThan(0);
	});

	it("observes shape changes made while a snapshot is live under collection stress", () => {
		assertExactLines(runToStdout(compiled, { env: STRESS_ENV }), expected);
	});

	it("matches the interpreted semantics", () => {
		assertExactLines(runToStdout(interpreted), expected);
	});
});
