export const TEST262_METADATA = {
	path: ".cache/test262",
	repository: "tc39/test262",
	revision: "3655e7464de3d52643ecddd4b5f9f4f3e7f62398",
	buildPath: ".cache/mal-build/test262",
	cacheFile: ".cache/test262-cache.json",
	outputFile: "scripts/test262.json",

	/**
	 * Per-test binary run timeout. Loops are compilable now, so runaway tests
	 * are a real possibility. Keep enough scheduler headroom for Unicode-scale
	 * string construction and large dynamic-function stress tests while retaining
	 * a bounded cost for a hung worker.
	 */
	runTimeoutMs: 10_000,
	// Full-suite batches can exceed one minute on the largest generated C units;
	// timing those out is counterproductive because the single-test fallback then
	// recompiles hundreds of files while competing with the remaining workers.
	compileTimeoutMs: 180_000,

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
};
