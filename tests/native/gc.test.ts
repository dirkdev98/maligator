import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	assertPassLine,
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	resolveHarnessExecutionInvocation,
	scaledNativeRunTimeoutMs,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-gc-"));

const HOST_GC: NodeJS.ProcessEnv = { MAL_HOST_GC: "1" };

/**
 * A GC fixture and how to drive it. The weak-pass / coroutine fixtures need the
 * HOST event loop (real macrotask turns → a microtask checkpoint per turn, so
 * ClearKeptObjects runs and enqueued FinalizationRegistry jobs drain); the
 * synchronous fixtures use the default test262 main.
 */
interface GcFixture {
	fixture: string;
	name: string;
	tag: string;
	mainFile?: string;
	/** Extra run env merged into every run of this fixture (both plain and stress). */
	env?: NodeJS.ProcessEnv;
	/** Runtime compilation uses the same interval as the dedicated compiler GC lane. */
	stressEnv?: NodeJS.ProcessEnv;
}

const FIXTURES: Array<GcFixture> = [
	// Cycle reclamation + root-frame + call-return poll rooting (live-bytes based).
	{ fixture: "tests/local/gctest.js", name: "gctest", tag: "gctest" },
	// WeakRef / FinalizationRegistry / ClearKeptObjects + cycle reclamation observed
	// via the weak pass.
	{
		fixture: "tests/local/gcweak.js",
		name: "gcweak",
		tag: "gcweak",
		mainFile: HOST_MAIN,
	},
	// WeakMap ephemeron fixpoint: plain death, chained revival, key-in-own-value.
	{
		fixture: "tests/local/gcephemeron.js",
		name: "gcephemeron",
		tag: "gcephemeron",
		mainFile: HOST_MAIN,
	},
	// Coroutine-frame tracing: suspended generator/async/async-gen across GC +
	// regressions (uninit-frame and COMPLETED-frame).
	{
		fixture: "tests/local/gccoroutine.js",
		name: "gccoroutine",
		tag: "gccoroutine",
		mainFile: HOST_MAIN,
	},
	// The explicit collections bracket eval while its generator is suspended. Avoid
	// collecting the whole compiler heap at every instruction during compilation.
	{
		fixture: "tests/local/gccoroutine-eval.js",
		name: "gccoroutine-eval",
		tag: "gccoroutine-eval",
		mainFile: HOST_MAIN,
		stressEnv: { MAL_GC_STRESS: "1000", MAL_GC_VERIFY: "1" },
	},
	// RAW-table delete/clear barrier: Map/Set/dictionary deletes interleaved with GC.
	{ fixture: "tests/local/gctable.js", name: "gctable", tag: "gctable" },
	// Incremental major collection under AUTO-triggered cycles: a small threshold
	// + major-every-1 drive many auto cycles so the mark/sweep slices interleave with
	// live mutation (SATB + card barriers, coroutine-resume shade, weak refs).
	{
		fixture: "tests/local/gcconc.js",
		name: "gcconc",
		tag: "gcconc",
		mainFile: HOST_MAIN,
		env: { MAL_GC_THRESHOLD: "1048576", MAL_GC_MAJOR_EVERY: "1", MAL_GC_VERIFY: "1" },
	},
];

describe("targeted GC unit tests", () => {
	for (const spec of FIXTURES) {
		describe(spec.tag, () => {
			let compiled: string;
			let interp: string;
			beforeAll(() => {
				const pair = buildBackendPairFromOneProgramImage({
					fixture: spec.fixture,
					name: spec.name,
					mainFile: spec.mainFile,
					outDir,
				});
				({ compiled, interpreted: interp } = pair);
			});

			it("compiled backend", () => {
				assertPassLine(
					runToStdout(compiled, { env: { ...HOST_GC, ...spec.env } }),
					spec.tag,
				);
			});

			if (spec.tag === "gcconc") {
				it("runs an automatic major cycle across allocations", () => {
					const invocation = resolveHarnessExecutionInvocation(compiled);
					const result = spawnSync(invocation.executable, invocation.args, {
						env: { ...process.env, ...HOST_GC, ...spec.env, MAL_GC_STATS: "1" },
						encoding: "utf8",
						timeout: scaledNativeRunTimeoutMs(120_000),
					});
					if (result.error !== undefined) throw result.error;
					expect(result.status, result.stderr || result.stdout).toBe(0);
					assertPassLine(result.stdout, spec.tag);
					const cycles = Number(result.stderr.match(/\bcycles=(\d+)/)?.[1] ?? 0);
					const blackAllocation = Number(
						result.stderr.match(/\bover_tenure_bytes=(\d+)/)?.[1] ?? 0,
					);
					expect(cycles).toBeGreaterThan(0);
					expect(blackAllocation).toBeGreaterThan(0);
				});
			}

			it(
				"compiled + MAL_GC_STRESS + MAL_GC_VERIFY",
				() => {
					assertPassLine(
						runToStdout(compiled, {
							env: { ...HOST_GC, ...spec.env, ...(spec.stressEnv ?? STRESS_ENV) },
						}),
						spec.tag,
					);
				},
				scaledNativeRunTimeoutMs(120_000),
			);

			it("interpreter backend (Tier B root walk)", () => {
				assertPassLine(
					runToStdout(interp, { env: { ...HOST_GC, ...spec.env } }),
					spec.tag,
				);
			});

			it(
				"interpreter + MAL_GC_STRESS + MAL_GC_VERIFY",
				() => {
					assertPassLine(
						runToStdout(interp, {
							env: { ...HOST_GC, ...spec.env, ...(spec.stressEnv ?? STRESS_ENV) },
						}),
						spec.tag,
					);
				},
				scaledNativeRunTimeoutMs(120_000),
			);
		});
	}
});
