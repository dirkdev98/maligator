import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	resolveHarnessExecutionInvocation,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/regexp-anchored-prefix.mjs";
const expected = JSON.parse(
	execFileSync(process.execPath, [fixture], { encoding: "utf8" }),
) as Record<string, unknown>;
// The fixture's route loop: 2000 paths cycling through one hit on the first
// pattern, then a hit and two misses on both patterns.
const routeLoopExecs = (2000 / 4) * (1 + 2 + 2 + 2);
const counter = (stderr: string, name: string) =>
	Number(stderr.match(new RegExp(`\\b${name}=(\\d+)`))?.[1]);

describe("RegExp searches confined to one position", () => {
	const outDir = mkdtempSync(join(tmpdir(), "mal-regexp-anchored-prefix-"));
	afterAll(() => rmSync(outDir, { recursive: true, force: true }));
	const outputs: Array<Record<string, unknown>> = [];
	let compiled = "";
	beforeAll(() => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "regexp-anchored-prefix",
			outDir,
			config: resolveBuildConfig({
				engine: {
					eval: false,
					realms: false,
					regexp: true,
					intl: { enabled: false },
					temporal: false,
				},
			}),
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		compiled = pair.compiled;
		const sanitized = ["MAL_ASAN", "MAL_UBSAN", "MAL_TSAN"].some(
			(key) => process.env[key] === "1",
		);
		for (const binary of [pair.compiled, pair.interpreted])
			for (const env of sanitized ? [{}] : [{}, STRESS_ENV])
				outputs.push(JSON.parse(runToStdout(binary, { env })) as Record<string, unknown>);
	});

	it.each(Object.keys(expected))("matches Node for %s", (key) => {
		for (const output of outputs) expect(output[key]).toEqual(expected[key]);
	});

	it("runs the route loop on the allocation-free engine", () => {
		const invocation = resolveHarnessExecutionInvocation(compiled);
		const result = spawnSync(invocation.executable, invocation.args, {
			env: { ...process.env, MAL_PERF_STATS: "1" },
			encoding: "utf8",
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual(expected);
		expect(counter(result.stderr, "fast_exec_calls")).toBeGreaterThanOrEqual(
			routeLoopExecs,
		);
	});
});
