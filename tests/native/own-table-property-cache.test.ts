import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/own-table-property-cache.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-own-table-property-cache-"));

describe("dictionary own-property cache hints", () => {
	let expected: string;
	let compiled: string;
	let interpreted: string;
	beforeAll(() => {
		expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
			encoding: "utf8",
		});
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "own-table-property-cache",
			outDir,
		}));
	});

	it("matches Node through mutation, layout changes, accessors, and exotic receivers", () => {
		expect(runToStdout(compiled, { env: { MAL_HOST_GC: "1" } })).toBe(expected);
		expect(runToStdout(interpreted, { env: { MAL_HOST_GC: "1" } })).toBe(expected);
	});

	it("keeps current receivers and values live across collection", () => {
		const env = { ...STRESS_ENV, MAL_HOST_GC: "1" };
		expect(runToStdout(compiled, { env })).toBe(expected);
		expect(runToStdout(interpreted, { env })).toBe(expected);
	});

	it("uses validated entry hints for repeated mutable dictionary reads", () => {
		const binary = buildNativeBinary({
			fixture,
			name: "own-table-property-cache-perf",
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		const result = spawnSync(binary, [], {
			env: { ...process.env, MAL_PERF_STATS: "1", MAL_HOST_GC: "1" },
			encoding: "utf8",
			timeout: 60_000,
		});
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe(expected);
		const hits = Number(result.stderr.match(/load_own_table_hits=(\d+)/)?.[1] ?? -1);
		expect(hits).toBeGreaterThanOrEqual(500);
	});
});
