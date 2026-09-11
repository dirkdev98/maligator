import * as path from "node:path";
import { maligatorCacheDirectory } from "../cache-root.ts";

const revision = "3655e7464de3d52643ecddd4b5f9f4f3e7f62398";

export const TEST262_METADATA = {
	path: path.join(maligatorCacheDirectory(), "test262-corpora", revision),
	repository: "tc39/test262",
	revision,
	buildPath: ".cache/mal-build/test262",
	outputFile: "scripts/test262.json",

	// Four full-suite workers can double the wall time of valid native stress tests.
	runTimeoutMs: 30_000,
	// Full-suite batches can exceed one minute on the largest generated C units;
	// timing those out is counterproductive because the single-test fallback then
	// recompiles hundreds of files while competing with the remaining workers.
	compileTimeoutMs: 180_000,
	/** Persist every per-test runtime above this threshold in local reports. */
	runtimeOutlierThresholdMs: 5_000,

	/**
	 * Full-suite throughput tuning, measured on an 11-core Apple M3 Pro:
	 *
	 * - 100 tests per translation unit keeps generated C units within cc's practical
	 *   memory budget. Partial runs shrink toward
	 *   25 tests to keep two batches queued per worker instead of leaving workers
	 *   idle behind one or two large translation units.
	 * - Up to 4 compile workers avoids memory-pressure failures when several large
	 *   translation units reach cc together. Clamp to the host's available
	 *   parallelism on smaller machines.
	 * - Generated test C stays at -O0: -O1/-O2/-Os made cold compiled runs ~2.4x
	 *   slower and Test262 does not execute a body enough to recover that cost.
	 * - LibMaligator uses the normal project -O2 build; -O1/-O3 were equivalent,
	 *   while -O0 was ~15% slower.
	 * - Keep the full IR optimization pipeline. Reduced profiles saved ~19% cold
	 *   wall time but changed conformance. LTO stays off because per-batch relinking
	 *   made warm runs ~4.2x slower.
	 *
	 * Change these constants/code-level choices only for a deliberate benchmark;
	 * they are not CLI options because each dimension changes cache identity and
	 * makes routine runs difficult to compare.
	 */
	batchSize: 100,
	minimumBatchSize: 25,
	targetBatchesPerWorker: 2,
	compileWorkers: 4,
	/** Hard post-run cap for each partial strictness/backend object-cache dimension. */
	partialObjectCacheMaxBytes: 1024 ** 3,
};
