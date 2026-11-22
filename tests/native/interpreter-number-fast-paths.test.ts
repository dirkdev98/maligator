import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	resolveHarnessExecutionInvocation,
	runToStdout,
} from "../../src/test-harness.ts";

const fixture = "tests/local/interpreter-number-fast-paths.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-interpreter-number-fast-paths-"));
const buildEnvironment = { ...process.env, MAL_PERF_STATS: "1" };
const defaultInput = { MAL_TEST_NUMBER_FALLBACKS: "0" };
const fallbackInput = { MAL_TEST_NUMBER_FALLBACKS: "1" };
const worlds = {
	locked: resolveBuildConfig({}),
	open: resolveBuildConfig({
		engine: { primordials: "mutable", eval: true, realms: true },
	}),
};

afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function runWithStats(target: string, input: NodeJS.ProcessEnv) {
	const { executable, args } = resolveHarnessExecutionInvocation(target);
	const result = spawnSync(executable, args, {
		encoding: "utf-8",
		env: { ...buildEnvironment, ...input },
		timeout: 60_000,
	});
	if (result.error !== undefined) throw result.error;
	expect(result.status, result.stderr).toBe(0);
	const line = result.stderr.match(/^\[perf-interpreter-stats\].*$/m)?.[0];
	if (line === undefined) throw new Error(`Missing interpreter stats:\n${result.stderr}`);
	return {
		stdout: result.stdout,
		count: (name: string) => Number(line.match(new RegExp(` ${name}=(\\d+)\\b`))?.[1]),
	};
}

describe("interpreter number fast paths", () => {
	let expected: string;
	const binaries = new Map<
		string,
		ReturnType<typeof buildBackendPairFromOneProgramImage>
	>();

	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], {
			encoding: "utf-8",
			env: { ...process.env, ...defaultInput },
		});
		for (const [world, config] of Object.entries(worlds)) {
			binaries.set(
				world,
				buildBackendPairFromOneProgramImage({
					fixture,
					name: `interpreter-number-fast-paths-${world}`,
					outDir,
					config,
					environment: buildEnvironment,
				}),
			);
		}
	}, 1_200_000);

	it("matches Node for unary, Math, DataView and typed-array length operands and their fallbacks", () => {
		for (const [world, pair] of binaries) {
			for (const backend of ["compiled", "interpreted"] as const) {
				expect(
					runToStdout(pair[backend], { env: defaultInput }),
					`${world} ${backend}`,
				).toBe(expected);
			}
		}
	});

	it("counts Number unary operations, known Math, DataView and typed-array length fast paths", () => {
		const locked = binaries.get("locked")!.interpreted;
		const admitted = runWithStats(locked, defaultInput);
		const fallback = runWithStats(locked, fallbackInput);
		expect(fallback.stdout).toBe(
			execFileSync(process.execPath, [fixture], {
				encoding: "utf-8",
				env: { ...process.env, ...fallbackInput },
			}),
		);
		expect(admitted.count("number_unary_hits")).toBeGreaterThan(
			fallback.count("number_unary_hits"),
		);
		for (const name of [
			"known_math_hits",
			"data_view_get_hits",
			"data_view_set_hits",
			"typed_array_length_hits",
		]) {
			expect(admitted.count(name), name).toBeGreaterThan(0);
			expect(fallback.count(name), name).toBe(0);
		}
		expect(
			runWithStats(binaries.get("open")!.interpreted, defaultInput).count(
				"known_math_hits",
			),
		).toBe(0);
	});
});
