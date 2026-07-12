import * as os from "node:os";
import { defineConfig } from "vitest/config";

// Native tests build + link a C binary per fixture and spawn it; cap parallelism
// so we don't launch a swarm of cc/link + server processes at once (battery-friendly,
// matches the test262 half-cores default).
const nativeForks = Math.max(2, Math.floor(os.cpus().length / 2));

export default defineConfig({
	test: {
		coverage: {
			provider: "v8",
		},
		experimental: {
			fsModuleCache: true,
			fsModuleCachePath: ".cache/vitest",
		},

		projects: [
			{
				// Pure-TS compiler tests: no C build, instant, the watch loop.
				test: {
					name: "unit",
					include: ["tests/*.test.ts", "src/serialize-vm.test.ts"],
					pool: "threads",
					isolate: false,
					sequence: {
						// Distinct groupOrder per project: vitest requires it when projects
						// differ in maxWorkers. The fast unit lane runs first (group 0).
						groupOrder: 0,
						concurrent: true,
						shuffle: { files: true, tests: true },
					},
				},
			},
			{
				// Feature-acceptance tests: build a fixture into a real isolate binary
				// (or server) and drive it. globalSetup builds the shared archives once.
				test: {
					name: "native",
					include: ["tests/native/**/*.test.ts"],
					globalSetup: ["tests/native/setup.ts"],
					pool: "forks",
					maxWorkers: nativeForks,
					sequence: { groupOrder: 1 },
					testTimeout: 60000,
					hookTimeout: 180000,
				},
			},
		],
	},
});
