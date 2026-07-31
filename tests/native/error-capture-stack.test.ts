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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-error-capture-stack-"));

describe("Error.captureStackTrace", () => {
	let compiled: string;
	let interpreted: string;
	let instrumented: string;
	let pinnedCompiled: string;
	let pinnedInterpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/error-capture-stack.js",
			name: "error-capture-stack-compiled",
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/error-capture-stack.js",
			name: "error-capture-stack-interpreted",
			outDir,
			compiled: false,
		});
		instrumented = buildNativeBinary({
			fixture: "tests/local/error-capture-stack.js",
			name: "error-capture-stack-perf",
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		pinnedCompiled = buildNativeBinary({
			fixture: "tests/fixtures/express-5/error-stack-smoke.cjs",
			name: "error-stack-pinned-compiled",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		pinnedInterpreted = buildNativeBinary({
			fixture: "tests/fixtures/express-5/error-stack-smoke.cjs",
			name: "error-stack-pinned-interpreted",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
			compiled: false,
		});
	});

	it("passes focused semantics compiled and interpreted", () => {
		assertResultPass(runToStdout(compiled));
		assertResultPass(runToStdout(interpreted));
	});

	it("loads pinned unmodified depd and http-errors compiled and interpreted", () => {
		assertResultPass(runToStdout(pinnedCompiled));
		assertResultPass(runToStdout(pinnedInterpreted));
	});

	it("passes focused and pinned fixtures under GC stress", () => {
		assertResultPass(runToStdout(compiled, { env: STRESS_ENV }));
		assertResultPass(runToStdout(interpreted, { env: STRESS_ENV }));
		assertResultPass(runToStdout(pinnedCompiled, { env: STRESS_ENV }));
		assertResultPass(runToStdout(pinnedInterpreted, { env: STRESS_ENV }));
	});

	it("recycles native trace slots during replacement and collection", () => {
		const result = spawnSync(instrumented, [], {
			env: { ...process.env, ...STRESS_ENV, MAL_PERF_STATS: "1" },
			encoding: "utf-8",
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		assertResultPass(result.stdout);
		const line = result.stderr
			.split("\n")
			.find((candidate) => candidate.startsWith("[perf-allocation-stats]"));
		expect(line).toBeDefined();
		const field = (name: string): number =>
			Number(line?.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)`))?.[1] ?? 0);
		expect(field("error_trace_stores")).toBeGreaterThan(600);
		expect(field("error_trace_releases")).toBeGreaterThan(500);
		expect(field("error_trace_peak_live")).toBeLessThan(field("error_trace_stores") / 4);
	});
});
