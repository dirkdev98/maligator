import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/direct-entry-abi.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-direct-entry-abi-"));

describe("native direct-entry ABI", () => {
	let expected: string;
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "direct-entry-abi",
			config: resolveBuildConfig({}),
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		}));
	}, 600_000);

	it("preserves calls, captures, arguments, exceptions, and GC behavior", () => {
		for (const binary of [compiled, interpreted]) {
			expect(runToStdout(binary)).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 60_000 })).toBe(expected);
		}
	});

	it("executes the optimized ABI in the real compiled product", () => {
		const result = spawnSync(compiled, [], {
			encoding: "utf8",
			env: { ...process.env, MAL_PERF_STATS: "1" },
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(result.stdout).toBe(expected);
		const line = result.stderr
			.split("\n")
			.find((candidate) => candidate.startsWith("[perf-call-cache-stats]"));
		expect(line).toBeDefined();
		const hits = Number(line?.match(/direct_entry_hits=([0-9]+)/)?.[1] ?? 0);
		expect(hits).toBeGreaterThan(0);
	});
});
