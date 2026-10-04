import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	assertResultPass,
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-dictionary-direct-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function field(line: string, name: string): number {
	return Number(line.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)`))?.[1] ?? 0);
}

describe("dictionary receivers with dynamic string keys", () => {
	let compiled: string;
	let interpreted: string;
	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/dictionary-direct.js",
			name: "dictionary-direct",
			mainFile: HOST_MAIN,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		}));
	}, 600_000);

	for (const mode of ["compiled", "interpreted"] as const) {
		it(`preserves [[Get]] and [[Set]] semantics in ${mode} mode`, () => {
			const binary = mode === "compiled" ? compiled : interpreted;
			assertResultPass(runToStdout(binary));
			assertResultPass(runToStdout(binary, { env: STRESS_ENV }));
		});
	}

	it("serves own data reads and overwrites from the dictionary table", () => {
		const result = spawnSync(compiled, [], {
			env: { ...process.env, MAL_PERF_STATS: "1" },
			encoding: "utf-8",
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		assertResultPass(result.stdout);
		const line = result.stderr
			.split("\n")
			.find((candidate) => candidate.startsWith("[perf-ic-stats]"));
		expect(line).toBeDefined();
		// The 64-round loop reads and overwrites all 96 keys of one dictionary. Reads of
		// the one key a site's own-table row retains hit that row instead.
		expect(field(line ?? "", "load_dictionary_direct_hits")).toBeGreaterThanOrEqual(
			64 * 95,
		);
		expect(field(line ?? "", "store_dictionary_direct_hits")).toBeGreaterThanOrEqual(
			6144,
		);
	});
});
