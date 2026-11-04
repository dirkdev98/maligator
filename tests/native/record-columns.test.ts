import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/record-columns.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-record-columns-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function expected(scenario: string): string {
	return execFileSync(process.execPath, [fixture], {
		encoding: "utf8",
		env: { ...process.env, RECORD_COLUMNS_CASE: scenario },
	});
}

function measured(binary: string, scenario: string, environment: NodeJS.ProcessEnv = {}) {
	const run = spawnSync(binary, [], {
		encoding: "utf8",
		env: {
			...process.env,
			...environment,
			MAL_PERF_STATS: "1",
			RECORD_COLUMNS_CASE: scenario,
		},
	});
	expect(run.status, run.stderr).toBe(0);
	expect(run.stdout).toBe(expected(scenario));
	const counter = (name: string) =>
		Number(run.stderr.match(new RegExp(`${name}=(\\d+)`))?.[1] ?? 0);
	return {
		admissions: counter("record_columns_admissions"),
		flushes: counter("record_columns_flushes"),
		polls: counter("record_columns_polls"),
	};
}

describe("private record columns", () => {
	let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
	let precise: string;
	let mutable: string;
	beforeAll(() => {
		const shared = {
			fixture,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		};
		const config = resolveBuildConfig({
			engine: { eval: false, realms: false },
			surface: { node: true },
		});
		pair = buildBackendPairFromOneProgramImage({
			...shared,
			name: "record-columns",
			config,
		});
		precise = buildNativeBinary({
			...shared,
			name: "record-columns-precise",
			config,
			nativeStackRoots: "precise",
		});
		mutable = buildNativeBinary({
			...shared,
			name: "record-columns-mutable",
			config: resolveBuildConfig({
				engine: { primordials: "mutable", eval: false, realms: false },
				surface: { node: true },
			}),
		});
	});
	it.each([
		["ordinary", "updates private nested records across repeated traversals"],
		["changedKind", "writes columns back before a carried scalar changes kind"],
		["earlyReturn", "releases retained columns on an early return"],
		["throw", "releases retained columns while propagating an exception"],
		["aliases", "observes writes through another path to the same object"],
		["external", "updates externally supplied objects immediately"],
		["captured", "updates a captured object shared by multiple rows"],
		["escaped", "publishes the final fields of escaped records"],
		["specialNumbers", "preserves signed zero across column stores"],
	])("%s: %s", (scenario) => {
		const oracle = expected(scenario);
		for (const binary of [pair.compiled, pair.interpreted, precise])
			expect(runToStdout(binary, { env: { RECORD_COLUMNS_CASE: scenario } })).toBe(
				oracle,
			);
	});
	it("retains packed columns across repeated traversals", () => {
		for (const binary of [pair.compiled, precise])
			expect(measured(binary, "ordinary").admissions).toBeGreaterThan(0);
	});
	it("flushes packed Number writes before falling back", () => {
		for (const binary of [pair.compiled, precise]) {
			const counters = measured(binary, "changedKind");
			expect(counters.admissions).toBeGreaterThan(0);
			expect(counters.flushes).toBeGreaterThan(0);
		}
	});
	it.each(["aliases", "external", "captured", "escaped"])(
		"keeps %s graphs on their ordinary heap representation",
		(scenario) => {
			for (const binary of [pair.compiled, precise])
				expect(measured(binary, scenario).admissions).toBe(0);
		},
	);
	it.each(["ordinary", "changedKind", "earlyReturn", "throw"])(
		"roots %s columns through GC polls",
		(scenario) => {
			const oracle = expected(scenario);
			for (const binary of [pair.compiled, pair.interpreted, precise])
				expect(
					runToStdout(binary, { env: { ...STRESS_ENV, RECORD_COLUMNS_CASE: scenario } }),
				).toBe(oracle);
		},
	);
	it("preserves mutable Array iteration", () => {
		expect(measured(mutable, "mutableIterator").admissions).toBe(0);
	});
	it("services GC polls after packing while another heap graph remains live", () => {
		for (const binary of [pair.compiled, precise]) {
			const counters = measured(binary, "ordinary", STRESS_ENV);
			expect(counters.admissions).toBeGreaterThan(0);
			expect(counters.polls).toBeGreaterThan(0);
		}
	});
});
