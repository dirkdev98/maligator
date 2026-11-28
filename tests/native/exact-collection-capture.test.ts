import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/exact-collection-capture.js";
const pass = "exact-collection-capture PASS";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-exact-collection-capture-"));

function field(line: string, name: string): number {
	return Number(line.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)`))?.[1] ?? 0);
}

function mapStats(binary: string): string {
	const result = spawnSync(binary, [], {
		env: { ...process.env, MAL_PERF_STATS: "1" },
		encoding: "utf-8",
	});
	expect(result.status, result.stderr || result.stdout).toBe(0);
	assertExactLines(result.stdout, [pass]);
	return (
		result.stderr.split("\n").find((line) => line.startsWith("[perf-map-stats]")) ?? ""
	);
}

// Only locked primordials prove a collection's brand, so the locked build exercises
// the capture on proven receivers; the mutable build captures only at sites whose
// receiver it tests, and replaces the prototype methods afterwards.
describe("collection method capture on exact receivers", () => {
	const binaries: Array<string> = [];
	let locked: string;
	let mutableCompiled: string;

	beforeAll(() => {
		const environment = { ...process.env, MAL_PERF_STATS: "1" };
		const mutable = buildBackendPairFromOneProgramImage({
			fixture,
			name: "exact-collection-capture-mutable",
			outDir,
			environment,
		});
		const lockedPair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "exact-collection-capture-locked",
			outDir,
			environment,
			config: resolveBuildConfig({ engine: { primordials: "locked" } }),
		});
		locked = lockedPair.compiled;
		mutableCompiled = mutable.compiled;
		binaries.push(mutable.compiled, mutable.interpreted, locked, lockedPair.interpreted);
	}, 600_000);

	it("honours own shadows, reparenting and prototype method replacement", () => {
		for (const binary of binaries) assertExactLines(runToStdout(binary), [pass]);
	});

	it("keeps captured receivers live under GC stress", () => {
		for (const binary of binaries)
			assertExactLines(runToStdout(binary, { env: STRESS_ENV }), [pass]);
	});

	it("captures exact receivers inline and leaves changed receivers to the property load", () => {
		const line = mapStats(locked);
		expect(field(line, "exact_capture_hits")).toBeGreaterThan(0);
		expect(field(line, "exact_capture_misses")).toBeGreaterThan(0);
	});

	it("captures ordinary Maps and Sets inline at sites of unknown receivers", () => {
		expect(field(mapStats(mutableCompiled), "exact_capture_hits")).toBeGreaterThan(0);
	});
});
