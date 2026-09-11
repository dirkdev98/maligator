import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import { workerBudget, workerCount } from "./src/worker-budget.ts";

const budget = workerBudget(process.env.MALIGATOR_WORKERS);
const sanitizerBuild = process.env.MAL_ASAN === "1" || process.env.MAL_UBSAN === "1";
const nativeForks = sanitizerBuild
	? workerCount(
			process.env.MAL_SANITIZER_WORKERS,
			"MAL_SANITIZER_WORKERS",
			Math.min(2, budget),
			budget,
		)
	: budget;
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
				test: {
					name: "unit",
					include: runningFullOnlyUnitTests ? fullOnlyUnitTests : ["tests/**/*.test.ts"],
					exclude: [
						"tests/native/**",
						"tests/fixtures/**",
						...(runningFullOnlyUnitTests ? [] : fullOnlyUnitTests),
					],
					pool: "threads",
					maxWorkers: budget,
					setupFiles: ["tests/setup-workers.ts"],
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
				test: {
					name: "native",
					include: ["tests/native/**/*.test.ts"],
					globalSetup: ["tests/native/setup.ts"],
					setupFiles: ["tests/setup-workers.ts"],
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
