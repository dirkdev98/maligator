import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-events-"));

describe("node:events", () => {
	let esmCompiled: string;
	let esmInterpreted: string;
	let cjsCompiled: string;
	let cjsInterpreted: string;
	let perfCompiled: string;

	beforeAll(() => {
		esmCompiled = buildNativeBinary({
			fixture: "tests/local/node-events.mjs",
			name: "node-events-esm-compiled",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		esmInterpreted = buildNativeBinary({
			fixture: "tests/local/node-events.mjs",
			name: "node-events-esm-interpreted",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
			compiled: false,
		});
		cjsCompiled = buildNativeBinary({
			fixture: "tests/local/node-events.cjs",
			name: "node-events-cjs-compiled",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		cjsInterpreted = buildNativeBinary({
			fixture: "tests/local/node-events.cjs",
			name: "node-events-cjs-interpreted",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
			compiled: false,
		});
		perfCompiled = buildNativeBinary({
			fixture: "tests/local/node-events-perf.mjs",
			name: "node-events-perf-compiled",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
	}, 1_200_000);

	it("passes ESM compiled", () => {
		assertResultPass(runToStdout(esmCompiled));
	});

	it("passes ESM interpreted", () => {
		assertResultPass(runToStdout(esmInterpreted));
	});

	it("passes CommonJS compiled", () => {
		assertResultPass(runToStdout(cjsCompiled));
	});

	it("passes CommonJS interpreted", () => {
		assertResultPass(runToStdout(cjsInterpreted));
	});

	it("passes under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertResultPass(runToStdout(esmCompiled, { env: STRESS_ENV }));
		assertResultPass(runToStdout(cjsCompiled, { env: STRESS_ENV }));
	});

	it("reports singleton storage and array transitions exactly", () => {
		const result = spawnSync(perfCompiled, [], {
			env: { ...process.env, MAL_PERF_STATS: "1" },
			encoding: "utf-8",
		});
		if (result.status !== 0) {
			throw new Error(result.stderr || result.stdout);
		}
		assertResultPass(result.stdout);
		const line = result.stderr
			.split("\n")
			.find((candidate) => candidate.startsWith("[perf-node-events-stats]"));
		if (line === undefined) throw new Error("missing [perf-node-events-stats]");
		const statsLine: string = line;

		function field(name: string): number {
			const match = statsLine.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)(?:\\s|$)`));
			if (match === null) throw new Error(`missing node-events counter ${name}`);
			return Number(match[1]);
		}

		expect(field("singleton_inserts")).toBe(3);
		expect(field("listener_array_allocations")).toBe(3);
		expect(field("listener_array_copied_entries")).toBe(5);
		expect(field("promotions")).toBe(1);
		expect(field("demotions")).toBe(1);
	});
});
