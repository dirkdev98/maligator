import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-regexp-case-span-"));

describe("RegExp capture ASCII case summary", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/regexp-case-span.js",
			name: "regexp-case-span",
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/regexp-case-span.js",
			name: "regexp-case-span-interpreted",
			compiled: false,
			outDir,
		});
	});

	it("preserves compiled and interpreted semantics", () => {
		assertResultPass(runToStdout(compiled));
		assertResultPass(runToStdout(interpreted));
	});

	it("keeps the hot compiled captures as spans", () => {
		const result = spawnSync(compiled, [], {
			env: { ...process.env, MAL_PERF_STATS: "1" },
			encoding: "utf-8",
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		assertResultPass(result.stdout);
		const line = result.stderr
			.split("\n")
			.find((candidate) => candidate.startsWith("[perf-string-stats]"));
		expect(line).toBeDefined();
		expect(Number(line?.match(/(?:^|\s)case_calls=([0-9]+)/)?.[1])).toBeLessThan(20);
	});

	it("preserves the summary under GC stress", () => {
		assertResultPass(runToStdout(compiled, { env: STRESS_ENV }));
	});
});
