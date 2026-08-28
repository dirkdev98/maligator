import { readFileSync } from "node:fs";
import * as os from "node:os";
import { defineConfig } from "vitest/config";

// Native tests build + link a C binary per fixture and spawn it; cap parallelism
// so we don't launch a swarm of cc/link + server processes at once (battery-friendly,
// matches the test262 half-cores default).
// Instrumented binaries are much heavier and can otherwise starve each other's
// fixed-startup tests and child-process deadlines under the full sanitizer lane.
const sanitizerBuild = process.env.MAL_ASAN === "1" || process.env.MAL_UBSAN === "1";
const configuredSanitizerWorkers = Number(process.env.MAL_SANITIZER_WORKERS ?? "1");
if (!Number.isInteger(configuredSanitizerWorkers) || configuredSanitizerWorkers < 1) {
	throw new Error("MAL_SANITIZER_WORKERS must be a positive integer");
}
const nativeForks = sanitizerBuild
	? Math.min(configuredSanitizerWorkers, os.availableParallelism())
	: Math.max(2, Math.floor(os.cpus().length / 2));
const fullOnlyUnitTests = readFileSync(
	new URL("./tests/test-suite-unit-full-only.txt", import.meta.url),
	"utf8",
)
	.split("\n")
	.map((line) => line.trim())
	.filter((line) => line.length > 0 && !line.startsWith("#"));
const runningFullOnlyUnitTests = process.env.MAL_TEST_UNIT_FULL_ONLY === "1";

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
					include: runningFullOnlyUnitTests ? fullOnlyUnitTests : ["tests/**/*.test.ts"],
					exclude: [
						"tests/native/**",
						"tests/fixtures/**",
						...(runningFullOnlyUnitTests ? [] : fullOnlyUnitTests),
					],
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
