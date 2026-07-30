import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { assertPassLine, buildNativeBinary, STRESS_ENV } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-object-rest-shaped-"));
const fixture = "tests/local/object-rest-shaped.js";
const hostGc = { MAL_HOST_GC: "1" };

function run(binary: string, env: NodeJS.ProcessEnv = {}): string {
	const result = spawnSync(binary, [], {
		env: { ...process.env, ...hostGc, ...env },
		encoding: "utf-8",
		timeout: 60_000,
	});
	if (result.error !== undefined) throw result.error;
	expect(result.status, result.stderr || result.stdout).toBe(0);
	assertPassLine(result.stdout, "object-rest-shaped");
	return result.stderr;
}

function perfField(stderr: string, field: string): number {
	return Number(stderr.match(new RegExp(`(?:^|\\s)${field}=([0-9]+)`))?.[1] ?? -1);
}

describe("shaped object-rest construction", () => {
	let compiled: string;
	let interpreted: string;
	let instrumented: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture,
			name: "object-rest-shaped-compiled",
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture,
			name: "object-rest-shaped-interpreted",
			compiled: false,
			outDir,
		});
		instrumented = buildNativeBinary({
			fixture,
			name: "object-rest-shaped-perf",
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
	});

	it("preserves compiled and interpreted semantics", () => {
		run(compiled);
		run(interpreted);
	});

	it("survives GC stress and verification", () => {
		run(compiled, STRESS_ENV);
		run(interpreted, STRESS_ENV);
	});

	it("uses the shaped path while retaining semantic fallbacks", () => {
		const stderr = run(instrumented, { MAL_PERF_STATS: "1" });
		expect(stderr).toContain("[perf-property-stats]");
		expect(perfField(stderr, "copy_linear_checks")).toBeGreaterThan(0);
		expect(perfField(stderr, "copy_shaped_hits")).toBeGreaterThan(0);
		expect(perfField(stderr, "copy_shaped_slots")).toBeGreaterThan(0);
		expect(perfField(stderr, "copy_fallbacks")).toBeGreaterThan(0);
	});
});
