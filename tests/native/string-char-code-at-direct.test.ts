import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	assertExactLines,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/string-char-code-at-direct.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-string-char-code-at-direct-"));

function field(line: string, name: string): number {
	return Number(line.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)`))?.[1] ?? 0);
}

describe("guarded direct String.prototype.charCodeAt", () => {
	let compiled: string;
	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture,
			name: "string-char-code-at-direct",
			compiled: true,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
	}, 600_000);

	it("preserves positions, coercion, receiver overrides, and prototype mutation", () => {
		assertExactLines(runToStdout(compiled), ["string-char-code-at-direct PASS"]);
	});

	it("remains correct under GC stress", () => {
		assertExactLines(runToStdout(compiled, { env: STRESS_ENV }), [
			"string-char-code-at-direct PASS",
		]);
	});

	it("takes primitive integer hits and unchanged generic fallbacks", () => {
		const result = spawnSync(compiled, [], {
			env: { ...process.env, MAL_PERF_STATS: "1" },
			encoding: "utf-8",
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		const line = result.stderr
			.split("\n")
			.find((candidate) => candidate.startsWith("[perf-string-stats]"));
		expect(line).toBeDefined();
		expect(field(line ?? "", "char_code_at_direct_hits")).toBeGreaterThan(4900);
		expect(field(line ?? "", "char_code_at_direct_fallbacks")).toBeGreaterThanOrEqual(3);
	});
});
