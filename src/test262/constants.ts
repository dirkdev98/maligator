export const TEST262_METADATA = {
	path: ".cache/test262",
	repository: "tc39/test262",
	buildPath: ".cache/test262-build",
	cacheFile: ".cache/test262-cache.json",
	outputFile: "scripts/test262.json",

	/**
	 * Per-test binary run timeout. Loops are compilable now, so runaway tests
	 * are a real possibility.
	 */
	runTimeoutMs: 5_000,
	compileTimeoutMs: 30_000,
};
