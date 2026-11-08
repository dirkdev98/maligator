import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	resolveHarnessExecutionInvocation,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
import { preparedNativeEvalConfig } from "../helpers/native-eval-config.ts";

const fixture = "tests/local/canonical-typed-dispatch.cjs";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-canonical-typed-dispatch-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function dispatchStats(binary: string): { hits: number; fallbacks: number } {
	const invocation = resolveHarnessExecutionInvocation(binary);
	const result = spawnSync(invocation.executable, invocation.args, {
		env: { ...process.env, MAL_PERF_STATS: "1" },
		encoding: "utf-8",
	});
	expect(result.status, result.stderr || result.stdout).toBe(0);
	const line = result.stderr
		.split("\n")
		.find((candidate) => candidate.startsWith("[perf-typed-dispatch-stats]"));
	expect(line).toBeDefined();
	return {
		hits: Number(line?.match(/(?:^|\s)hits=([0-9]+)/)?.[1]),
		fallbacks: Number(line?.match(/(?:^|\s)fallbacks=([0-9]+)/)?.[1]),
	};
}

describe("canonical typed dispatch", () => {
	let compiled: string;
	let interpreted: string;
	let expected: string;
	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "canonical-typed-dispatch",
			outDir,
			config: preparedNativeEvalConfig(),
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		}));
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	}, 600_000);

	it("matches Node for Number and every other argument shape", () => {
		for (const binary of [compiled, interpreted]) {
			expect(runToStdout(binary)).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 60000 })).toBe(expected);
		}
	});

	it("runs the Number variant for calls it cannot resolve", () => {
		// 6000 looping calls with Number arguments; the coercion cases keep the canonical body.
		const { hits, fallbacks } = dispatchStats(compiled);
		expect(hits).toBeGreaterThanOrEqual(6000);
		expect(fallbacks).toBeGreaterThan(0);
	});
});
