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

const expected = ["native-constructor-prototypes PASS"];
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-constructor-prototypes-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function fixedPrototypeHits(stderr: string): number {
	const line = stderr
		.split("\n")
		.find((candidate) => candidate.startsWith("[perf-construct-stats]"));
	return Number(line?.match(/(?:^|\s)fixed_prototype_hits=([0-9]+)/)?.[1] ?? -1);
}

describe("native constructor prototype reuse", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/native-constructor-prototypes.js",
			name: "native-constructor-prototypes",
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		}));
	}, 600_000);

	it("reuses a class constructor's immutable prototype", () => {
		const result = spawnSync(compiled, [], {
			env: { ...process.env, MAL_PERF_STATS: "1" },
			encoding: "utf-8",
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		assertExactLines(result.stdout, expected);
		expect(fixedPrototypeHits(result.stderr)).toBeGreaterThan(0);
	});

	it("rereads a prototype across sweeps and writable prototypes under collection stress", () => {
		assertExactLines(runToStdout(compiled, { env: STRESS_ENV }), expected);
	});

	it("matches the interpreted semantics", () => {
		assertExactLines(runToStdout(interpreted), expected);
	});
});
