import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout, STRESS_ENV } from "../../src/test-harness.ts";

function icStat(stderr: string, name: string): number {
	const line = stderr
		.split("\n")
		.find((candidate) => candidate.startsWith("[perf-ic-stats]"));
	return Number(line?.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)`))?.[1] ?? 0);
}

describe("inherited properties on builtin receivers", () => {
	it.each([
		["compiled", true],
		["interpreted", false],
	] as const)("follow shadowing and prototype changes in %s mode", (_name, compiled) => {
		const binary = buildNativeBinary({
			fixture: "tests/local/inherited-builtin-receiver-cache.mjs",
			name: `inherited-builtin-receiver-cache-${compiled ? "compiled" : "interpreted"}`,
			compiled,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		const run = spawnSync(binary, [], {
			env: { ...process.env, MAL_PERF_STATS: "1" },
			encoding: "utf-8",
		});
		expect(run.status, run.stderr || run.stdout).toBe(0);
		expect(run.stdout).toContain("INHERITED BUILTIN RECEIVER PASS 21");
		// The subclass sites record once instead of failing on each of their ~400 reads.
		expect(icStat(run.stderr, "inherited_reject_chain")).toBeLessThan(100);
		// The warm `byteLength` sites read the extent through their rows, not the getter.
		expect(icStat(run.stderr, "load_byte_length_hits")).toBeGreaterThan(150);
		expect(runToStdout(binary, { env: STRESS_ENV })).toContain(
			"INHERITED BUILTIN RECEIVER PASS 21",
		);
	});
});
