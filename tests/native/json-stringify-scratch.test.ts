import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-json-stringify-scratch-"));
const expected = ["json-stringify-scratch PASS"];
const hostGc = { MAL_HOST_GC: "1" };

describe("JSON.stringify traversal scratch buffers", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/json-stringify-scratch.js",
			name: "json-stringify-scratch",
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		}));
	});

	it("passes compiled and interpreted", () => {
		assertExactLines(runToStdout(compiled, { env: hostGc }), expected);
		assertExactLines(runToStdout(interpreted, { env: hostGc }), expected);
	});

	it("writes repeated scalar records of one shape whole", () => {
		const result = spawnSync(compiled, [], {
			env: { ...process.env, ...hostGc, MAL_PERF_STATS: "1" },
			encoding: "utf-8",
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		assertExactLines(result.stdout, expected);
		const flatRecords = /\bflat_records=(\d+)/.exec(result.stderr)?.[1];
		expect(Number(flatRecords ?? 0)).toBeGreaterThan(0);
	});

	it("passes compiled and interpreted under GC stress", () => {
		const env = { ...hostGc, ...STRESS_ENV };
		assertExactLines(runToStdout(compiled, { env }), expected);
		assertExactLines(runToStdout(interpreted, { env }), expected);
	});
});
