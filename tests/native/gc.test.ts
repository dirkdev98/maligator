import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertPassLine,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-gc-"));

// Forced-collection host hooks on for every run; the fixture asserts, a failed
// assertion throws (non-zero exit) which runToStdout surfaces. The whole suite is
// build-dimension-parametric: `MAL_GC_GENERATIONAL=1 npm run test:native` (or an
// MAL_UBSAN=1 build) re-runs every fixture under that dimension — globalSetup
// builds the matching archive and the fixtures link against it unchanged.
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
}

const FIXTURES: Array<GcFixture> = [
	// Cycle reclamation + root-frame + call-return poll rooting (live-bytes based).
	{ fixture: "tests/local/gctest.js", name: "gctest", tag: "gctest" },
	// WeakRef / FinalizationRegistry / ClearKeptObjects + cycle reclamation observed
	// via the weak pass.
	{ fixture: "tests/local/gcweak.js", name: "gcweak", tag: "gcweak", mainFile: HOST_MAIN },
	// WeakMap ephemeron fixpoint: plain death, chained revival, key-in-own-value.
	{
		fixture: "tests/local/gcephemeron.js",
		name: "gcephemeron",
		tag: "gcephemeron",
		mainFile: HOST_MAIN,
	},
	// Coroutine-frame tracing: suspended generator/async/async-gen across GC +
	// regressions (uninit-frame, COMPLETED-frame, post-eval-splice).
	{
		fixture: "tests/local/gccoroutine.js",
		name: "gccoroutine",
		tag: "gccoroutine",
		mainFile: HOST_MAIN,
	},
	// RAW-table delete/clear barrier: Map/Set/dictionary deletes interleaved with GC.
	{ fixture: "tests/local/gctable.js", name: "gctable", tag: "gctable" },
];

describe("targeted GC unit tests", () => {
	for (const spec of FIXTURES) {
		describe(spec.tag, () => {
			let compiled: string;
			let interp: string;
			beforeAll(() => {
				compiled = buildNativeBinary({
					fixture: spec.fixture,
					name: spec.name,
					compiled: true,
					mainFile: spec.mainFile,
					outDir,
					skipRuntimeBuild: true,
				});
				interp = buildNativeBinary({
					fixture: spec.fixture,
					name: `${spec.name}-ni`,
					compiled: false,
					mainFile: spec.mainFile,
					outDir,
					skipRuntimeBuild: true,
				});
			});

			it("compiled backend", () => {
				assertPassLine(runToStdout(compiled, { env: HOST_GC }), spec.tag);
			});

			it("compiled + MAL_GC_STRESS + MAL_GC_VERIFY", () => {
				assertPassLine(
					runToStdout(compiled, { env: { ...HOST_GC, ...STRESS_ENV } }),
					spec.tag,
				);
			});

			it("interpreter backend (Tier B root walk)", () => {
				assertPassLine(runToStdout(interp, { env: HOST_GC }), spec.tag);
			});

			it("interpreter + MAL_GC_STRESS + MAL_GC_VERIFY", () => {
				assertPassLine(
					runToStdout(interp, { env: { ...HOST_GC, ...STRESS_ENV } }),
					spec.tag,
				);
			});
		});
	}
});
