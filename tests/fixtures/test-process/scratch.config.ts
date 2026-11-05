import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// oxlint-disable-next-line import/no-default-export -- Vitest loads its configuration through the default export.
export default defineConfig({
	test: {
		include: [fileURLToPath(new URL("./scratch-*.test.ts", import.meta.url))],
		setupFiles: [fileURLToPath(new URL("../../native/scratch.ts", import.meta.url))],
		pool: "forks",
		maxWorkers: 1,
		fileParallelism: false,
	},
});
