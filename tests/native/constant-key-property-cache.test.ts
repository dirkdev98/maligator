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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-constant-key-cache-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function field(line: string, name: string): number {
	return Number(line.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)`))?.[1] ?? 0);
}

describe("computed accesses with literal keys", () => {
	let compiled: string;
	let interpreted: string;
	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/constant-key-property-cache.js",
			name: "constant-key-property-cache",
			mainFile: HOST_MAIN,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		}));
	}, 600_000);

	for (const mode of ["compiled", "interpreted"] as const) {
		it(`preserves property semantics in ${mode} mode`, () => {
			const binary = mode === "compiled" ? compiled : interpreted;
			assertResultPass(runToStdout(binary));
			assertResultPass(runToStdout(binary, { env: STRESS_ENV }));
		});
	}

	it("keeps serving a round's literal key from the site cache", () => {
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
		// 32,768 computed loads and as many stores change key once per round;
		// each miss refills the cache.
		expect(field(line ?? "", "load_fallbacks")).toBeLessThan(4096);
		expect(field(line ?? "", "store_fallbacks")).toBeLessThan(4096);
	});
});
