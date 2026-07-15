export const TEST262_METADATA = {
	path: ".cache/test262",
	repository: "tc39/test262",
	buildPath: ".cache/mal-build/test262",
	cacheFile: ".cache/test262-cache.json",
	outputFile: "scripts/test262.json",
	preflightFile: ".cache/test262-preflight.json",

	/**
	 * Per-test binary run timeout. Loops are compilable now, so runaway tests
	 * are a real possibility. Unicode-scale string construction and pathological
	 * generic Array lengths are optimized/validated before execution, so one second
	 * is enough for conforming cases while keeping a hung worker inexpensive.
	 */
	runTimeoutMs: 1_000,
	compileTimeoutMs: 60_000,

	/**
	 * Full-suite throughput tuning, measured on an 11-core Apple M3 Pro:
	 *
	 * - 200 tests per translation unit balances repeated link/process overhead
	 *   against large-batch tail latency for a full run. Partial runs shrink toward
	 *   25 tests to keep two batches queued per worker instead of leaving workers
	 *   idle behind one or two large translation units.
	 * - Up to 8 compile workers saturates the compiler without the contention seen
	 *   at 11. Clamp to the host's available parallelism on smaller machines.
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
	batchSize: 200,
	minimumBatchSize: 25,
	targetBatchesPerWorker: 2,
	compileWorkers: 8,
	preflightRegressionLimit: 0.05,
};
