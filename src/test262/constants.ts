export const TEST262_METADATA = {
	path: ".cache/test262",
	repository: "tc39/test262",
	buildPath: ".cache/test262-build",
	cacheFile: ".cache/test262-cache.json",
	outputFile: "scripts/test262.json",

	/**
	 * Per-test binary run timeout. Loops are compilable now, so runaway tests
	 * are a real possibility. Kept tight (5s) so a hung test stalls its worker
	 * only briefly — a handful of genuinely slow tests (heavy Unicode/4-byte-UTF-8
	 * loops) may TIMEOUT under full-run contention, which is accepted (they pass in
	 * isolation; see the never-overwrite-flaky-verdicts memory).
	 */
	runTimeoutMs: 5_000,
	compileTimeoutMs: 60_000,

	/**
	 * Tests per batched translation unit / binary.
	 */
	batchSize: 100,
};
