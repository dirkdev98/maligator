import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	assertPassLine,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/collection-direct.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-collection-direct-"));

function field(line: string, name: string): number {
	return Number(line.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)`))?.[1] ?? 0);
}

describe("guarded direct Map and Set dispatch", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture,
			name: "collection-direct",
			compiled: true,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		interpreted = buildNativeBinary({
			fixture,
			name: "collection-direct-interpreted",
			compiled: false,
			outDir,
		});
	}, 600_000);

	it("preserves collection semantics and guarded fallbacks", () => {
		assertPassLine(runToStdout(compiled), "collection-direct");
	});

	it("keeps directly stored keys and values live under GC stress", () => {
		assertPassLine(runToStdout(compiled, { env: STRESS_ENV }), "collection-direct");
	});

	it("preserves exact collection leaves in the portable interpreter", () => {
		assertPassLine(runToStdout(interpreted), "collection-direct");
		assertPassLine(runToStdout(interpreted, { env: STRESS_ENV }), "collection-direct");
	});

	it("takes each direct path while retaining generic misses", () => {
		const result = spawnSync(compiled, [], {
			env: { ...process.env, MAL_HOST_GC: "1", MAL_PERF_STATS: "1" },
			encoding: "utf-8",
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		assertPassLine(result.stdout, "collection-direct");
		const line = result.stderr
			.split("\n")
			.find((candidate) => candidate.startsWith("[perf-map-stats]"));
		expect(line).toBeDefined();
		expect(field(line ?? "", "direct_get_hits")).toBeGreaterThan(6000);
		expect(field(line ?? "", "direct_set_hits")).toBeGreaterThan(3000);
		expect(field(line ?? "", "direct_map_has_hits")).toBeGreaterThan(4000);
		expect(field(line ?? "", "direct_map_delete_hits")).toBeGreaterThan(4000);
		expect(field(line ?? "", "direct_add_hits")).toBeGreaterThan(3000);
		expect(field(line ?? "", "direct_set_has_hits")).toBeGreaterThan(4000);
		expect(field(line ?? "", "direct_set_delete_hits")).toBeGreaterThan(4000);
		expect(field(line ?? "", "direct_fallbacks")).toBeGreaterThanOrEqual(8);
	});
});
