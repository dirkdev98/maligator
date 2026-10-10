import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { emitProgramImage } from "../../src/compiler/target/emit-program-image.ts";
import type { ProgramImage } from "../../src/compiler/target/program-image.ts";
import {
	assertExactLines,
	buildNativeBinary,
	buildNativeBinaryResult,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/array-push-direct.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-array-push-direct-"));

function field(line: string, name: string): number {
	return Number(line.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)`))?.[1] ?? 0);
}

describe("guarded direct Array.prototype.push", () => {
	let compiled: string;
	let interpreted: string;
	let image: ProgramImage;
	beforeAll(() => {
		const result = buildNativeBinaryResult({
			fixture,
			name: "array-push-direct",
			compiled: true,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		compiled = result.binaryPath;
		image = result.programImage;
		interpreted = buildNativeBinary({
			fixture,
			name: "array-push-direct-interpreted",
			compiled: false,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
	}, 600_000);

	it("appends single values in place before calling the builtin", () => {
		expect(emitProgramImage(image, { compiled: true })).toContain(
			"mal_vm_array_push_one_try(",
		);
	});

	it("preserves overrides, mutation, exceptional fallbacks, and return values", () => {
		for (const binary of [compiled, interpreted]) {
			assertExactLines(runToStdout(binary), ["array-push-direct PASS"]);
		}
	});

	it("keeps appended values live under GC stress", () => {
		for (const binary of [compiled, interpreted]) {
			assertExactLines(runToStdout(binary, { env: STRESS_ENV }), [
				"array-push-direct PASS",
			]);
		}
	});

	it("takes both guarded dense hits and unchanged generic fallbacks", () => {
		for (const binary of [compiled, interpreted]) {
			const result = spawnSync(binary, [], {
				env: { ...process.env, MAL_PERF_STATS: "1" },
				encoding: "utf-8",
			});
			expect(result.status, result.stderr || result.stdout).toBe(0);
			const line = result.stderr
				.split("\n")
				.find((candidate) => candidate.startsWith("[perf-array-stats]"));
			expect(line).toBeDefined();
			expect(field(line ?? "", "push_direct_hits")).toBeGreaterThan(3000);
			expect(field(line ?? "", "push_direct_fallbacks")).toBeGreaterThanOrEqual(8);
		}
	});
});
