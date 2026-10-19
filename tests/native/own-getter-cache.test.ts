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

const fixture = "tests/local/own-getter-cache.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-own-getter-cache-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function field(line: string, name: string): number {
	return Number(line.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)`))?.[1] ?? 0);
}

describe("own getter cache rows", () => {
	let compiled: string;
	let interpreted: string;
	let expected: string;
	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "own-getter-cache",
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		}));
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	}, 600_000);

	it("call each receiver's current own getter as accessors are redefined and removed", () => {
		for (const binary of [compiled, interpreted]) {
			expect(runToStdout(binary)).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 60000 })).toBe(expected);
		}
	});

	it("serve repeated own accessor reads from the getter row", () => {
		const result = spawnSync(compiled, [], {
			env: { ...process.env, MAL_PERF_STATS: "1" },
			encoding: "utf-8",
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(result.stdout).toBe(expected);
		const line = result.stderr
			.split("\n")
			.find((candidate) => candidate.startsWith("[perf-ic-stats]"));
		expect(line).toBeDefined();
		// The steady loop alone reads three function instances' getters 150 times at one site.
		expect(field(line ?? "", "load_own_getter_hits")).toBeGreaterThanOrEqual(150);
	});
});
