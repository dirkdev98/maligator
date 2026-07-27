import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	assertExactLines,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-arguments-static-"));
const expected = ["arguments-static PASS"];

describe("static arguments access", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/arguments-static.js",
			name: "arguments-static",
			compiled: true,
			mainFile: HOST_MAIN,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/arguments-static.js",
			name: "arguments-static-ni",
			compiled: false,
			mainFile: HOST_MAIN,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
	});

	for (const [name, binary] of [
		["compiled", () => compiled],
		["interpreted", () => interpreted],
	] as const) {
		it(`${name} preserves direct and object arguments semantics`, () => {
			assertExactLines(runToStdout(binary()), expected);
		});
		it(`${name} preserves arguments lifetimes under GC stress`, () => {
			assertExactLines(
				runToStdout(binary(), { env: STRESS_ENV, timeoutMs: 60000 }),
				expected,
			);
		});
		it(`${name} reports snapshot move costs`, () => {
			const result = spawnSync(binary(), [], {
				encoding: "utf8",
				env: {
					...process.env,
					MAL_COROUTINE_STATS: "1",
					MAL_GC_STATS: "1",
					MAL_PERF_STATS: "1",
				},
			});
			expect(result.status, result.stderr || result.stdout).toBe(0);
			const line = result.stderr
				.split("\n")
				.find((candidate) => candidate.startsWith("[perf-arguments-stats]"));
			expect(line).toBeDefined();
			const field = (key: string): number =>
				Number(line?.match(new RegExp(`${key}=([0-9]+)`))?.[1] ?? -1);
			expect(field("logical_values")).toBe(38);
			expect(field("destination_writes")).toBe(38);
			expect(field("temporary_copies")).toBe(name === "interpreted" ? 2 : 0);
			const coroutine = result.stderr
				.split("\n")
				.find((candidate) => candidate.startsWith("[coroutine-stats]"));
			expect(coroutine).toBeDefined();
			expect(Number(coroutine?.match(/requests=([0-9]+)/)?.[1] ?? -1)).toBe(
				name === "compiled" ? 9 : 11,
			);
		});
	}
});
