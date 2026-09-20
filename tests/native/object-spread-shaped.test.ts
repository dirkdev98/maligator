import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	assertPassLine,
	buildBackendPairFromOneProgramImage,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/object-spread-shaped.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-object-spread-shaped-"));
const config = resolveBuildConfig({
	engine: { primordials: "mutable", eval: false, realms: false },
});
const hostGc = { MAL_HOST_GC: "1" };

function run(binary: string, env: NodeJS.ProcessEnv = {}): void {
	assertPassLine(
		runToStdout(binary, {
			env: { ...hostGc, ...env },
			timeoutMs: 60_000,
		}),
		"object-spread-shaped",
	);
}

function runInstrumented(binary: string): string {
	const result = spawnSync(binary, [], {
		env: { ...process.env, ...hostGc, MAL_PERF_STATS: "1" },
		encoding: "utf8",
		timeout: 60_000,
	});
	if (result.error !== undefined) throw result.error;
	expect(result.status, result.stderr || result.stdout).toBe(0);
	assertPassLine(result.stdout, "object-spread-shaped");
	return result.stderr;
}

function perfField(stderr: string, field: string): number {
	return Number(stderr.match(new RegExp(`(?:^|\\s)${field}=([0-9]+)`))?.[1] ?? -1);
}

describe("shaped object-spread merge", () => {
	let compiled: string;
	let interpreted: string;
	let instrumented: string;

	beforeAll(() => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "object-spread-shaped",
			config,
			outDir,
		});
		compiled = pair.compiled;
		interpreted = pair.interpreted;
		instrumented = buildNativeBinary({
			fixture,
			name: "object-spread-shaped-perf",
			config,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
	}, 600_000);

	afterAll(() => rmSync(outDir, { recursive: true, force: true }));

	it("preserves compiled and interpreted semantics", () => {
		run(compiled);
		run(interpreted);
	});

	it("survives GC stress and verification", () => {
		run(compiled, STRESS_ENV);
		run(interpreted, STRESS_ENV);
	});

	it("uses the shaped path while retaining semantic fallbacks", () => {
		const stderr = runInstrumented(instrumented);
		expect(stderr).toContain("[perf-property-stats]");
		expect(perfField(stderr, "merge_shaped_hits")).toBeGreaterThan(0);
		expect(perfField(stderr, "merge_shaped_slots")).toBeGreaterThan(0);
		expect(perfField(stderr, "merge_fallbacks")).toBeGreaterThan(0);
		expect(perfField(stderr, "merge_shape_cache_hits")).toBeGreaterThan(0);
		expect(perfField(stderr, "merge_shape_cache_builds")).toBeGreaterThan(0);
		expect(perfField(stderr, "merge_shape_cache_probes")).toBe(
			perfField(stderr, "merge_shape_cache_hits") +
				perfField(stderr, "merge_shape_cache_misses"),
		);
	});
});
