import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		coverage: {
			provider: "v8",
		},
		experimental: {
			fsModuleCache: true,
			fsModuleCachePath: ".cache/vitest",
		},

		sequence: {
			concurrent: true,

			shuffle: {
				files: true,
				tests: true,
			},
		},

		pool: "threads",
		isolate: false,
	},
});
