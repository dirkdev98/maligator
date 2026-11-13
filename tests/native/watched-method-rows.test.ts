import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	resolveHarnessExecutionInvocation,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/watched-method-rows.mjs";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-watched-method-rows-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

const counter = (stderr: string, name: string) =>
	Number(stderr.match(new RegExp(`\\b${name}=(\\d+)`))?.[1]);

describe("watched method rows filled after a startup polyfill", () => {
	let compiled: string;
	let interpreted: string;
	let expected: string;
	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "watched-method-rows",
			outDir,
			config: resolveBuildConfig({ engine: { primordials: "mutable" } }),
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		}));
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	});

	for (const backend of ["compiled", "interpreted"] as const) {
		it(`observes every later replacement in ${backend} mode`, () => {
			const binary = backend === "compiled" ? compiled : interpreted;
			expect(runToStdout(binary)).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
		});
	}

	it("serves warm method and namespace loads from their rows", () => {
		const invocation = resolveHarnessExecutionInvocation(compiled);
		const result = spawnSync(invocation.executable, invocation.args, {
			env: { ...process.env, MAL_PERF_STATS: "1" },
			encoding: "utf8",
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(result.stdout).toBe(expected);
		const loops = Number(result.stdout.match(/\bloops=(\d+)/)?.[1]);
		// Each warm-up round reads charCodeAt once per character of a 15-character
		// string, Math.floor eight times, and the absent `later` once.
		expect(counter(result.stderr, "load_primitive_hits")).toBeGreaterThanOrEqual(
			14 * loops,
		);
		expect(counter(result.stderr, "load_watched_hits")).toBeGreaterThanOrEqual(7 * loops);
		expect(counter(result.stderr, "load_builtin_missing_hits")).toBeGreaterThanOrEqual(
			loops - 1,
		);
	});
});
