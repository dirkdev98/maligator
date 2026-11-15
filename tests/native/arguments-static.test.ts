import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	assertExactLines,
	buildNativeBinary,
	buildNativeBinaryResult,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-arguments-static-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
const expected = ["arguments-static PASS"];

describe("static arguments access", () => {
	let compiled: string;
	let interpreted: string;
	let compiledStress: string;
	let interpretedStress: string;

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
		compiledStress = buildNativeBinary({
			fixture: "tests/local/arguments-static-stress.js",
			name: "arguments-static-stress",
			compiled: true,
			mainFile: HOST_MAIN,
			outDir,
		});
		interpretedStress = buildNativeBinary({
			fixture: "tests/local/arguments-static-stress.js",
			name: "arguments-static-stress-ni",
			compiled: false,
			mainFile: HOST_MAIN,
			outDir,
		});
	});

	for (const [name, binary, stressBinary] of [
		["compiled", () => compiled, () => compiledStress],
		["interpreted", () => interpreted, () => interpretedStress],
	] as const) {
		it(`${name} preserves direct and object arguments semantics`, () => {
			assertExactLines(runToStdout(binary()), expected);
		});
		it(`${name} preserves arguments lifetimes under GC stress`, () => {
			assertExactLines(
				runToStdout(stressBinary(), { env: STRESS_ENV, timeoutMs: 60000 }),
				["arguments-static-stress PASS"],
			);
		});
		it(`${name} reports snapshot move costs`, () => {
			const built = buildNativeBinaryResult({
				fixture: "tests/local/arguments-snapshot-costs.js",
				name: `arguments-snapshot-costs-${name}`,
				compiled: name === "compiled",
				mainFile: HOST_MAIN,
				outDir,
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			const snapshotFunctions = built.programImage.runtime.functions.filter(
				(fn) => fn.argumentSnapshotCount > 0,
			);
			const logicalValues = snapshotFunctions.reduce(
				(total, fn) => total + fn.argumentSnapshotCount,
				0,
			);
			const result = spawnSync(built.binaryPath, [], {
				encoding: "utf8",
				env: {
					...process.env,
					MAL_GC_STATS: "1",
					MAL_PERF_STATS: "1",
				},
			});
			expect(result.status, result.stderr || result.stdout).toBe(0);
			expect(result.stdout).toBe("arguments-snapshot-costs PASS\n");
			const line = result.stderr
				.split("\n")
				.find((candidate) => candidate.startsWith("[perf-arguments-stats]"));
			expect(line).toBeDefined();
			const field = (key: string): number =>
				Number(line?.match(new RegExp(`${key}=([0-9]+)`))?.[1] ?? -1);
			expect(logicalValues).toBeGreaterThan(0);
			expect(field("logical_values")).toBe(logicalValues);
			// Indirect calls keep incoming arguments separate from destination registers.
			expect(field("destination_writes")).toBe(logicalValues);
			expect(field("temporary_copies")).toBe(name === "interpreted" ? 2 : 0);
		});
	}
});
