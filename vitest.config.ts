import { defineProject } from "vitest/config";

export default defineProject({
	test: {
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
