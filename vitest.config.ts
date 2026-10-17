import { readFileSync } from "node:fs";
import * as path from "node:path";
import { defineConfig } from "vitest/config";
import { BaseSequencer } from "vitest/node";
import type { TestSpecification } from "vitest/node";
import { readShardDurations } from "./scripts/test-suite-shards.ts";
import { workerBudget, workerCount } from "./src/worker-budget.ts";

const budget = workerBudget(process.env.MALIGATOR_WORKERS);
const testWorkers = workerCount(
	process.env.MAL_TEST_WORKERS,
	"MAL_TEST_WORKERS",
	budget,
	budget,
);
const sanitizerBuild = process.env.MAL_ASAN === "1" || process.env.MAL_UBSAN === "1";
const nativeForks = sanitizerBuild
	? workerCount(
			process.env.MAL_SANITIZER_WORKERS,
			"MAL_SANITIZER_WORKERS",
			Math.min(2, testWorkers),
			testWorkers,
		)
	: testWorkers;
const fullOnlyUnitTests = readFileSync(
	new URL("./tests/test-suite-unit-full-only.txt", import.meta.url),
	"utf8",
)
	.split("\n")
	.map((line) => line.trim())
	.filter((line) => line.length > 0 && !line.startsWith("#"));
const runningFullOnlyUnitTests = process.env.MAL_TEST_UNIT_FULL_ONLY === "1";
const LONG_NATIVE_FILE_SECONDS = 60;

/**
 * Shuffles files with the run's seed, as `shuffle.files` does, except that native files
 * recorded at a minute or more start first, longest first: a long file that starts last
 * otherwise sets the length of its whole shard.
 */
class LongNativeFilesFirst extends BaseSequencer {
	override sort(files: Array<TestSpecification>): Promise<Array<TestSpecification>> {
		let state = this.ctx.config.sequence.seed >>> 0;
		const random = () => {
			state = (state + 0x6d2b79f5) >>> 0;
			let mixed = Math.imul(state ^ (state >>> 15), state | 1);
			mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
			return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
		};
		const shuffled = [...files];
		for (let index = shuffled.length - 1; index > 0; index--) {
			const other = Math.floor(random() * (index + 1));
			[shuffled[index], shuffled[other]] = [shuffled[other]!, shuffled[index]!];
		}
		const recorded = readShardDurations(
			this.ctx.config.root,
			process.platform,
			sanitizerBuild ? "sanitizer" : undefined,
		).files;
		const seconds = (file: TestSpecification) =>
			file.project.name === "native"
				? (recorded.get(path.relative(this.ctx.config.root, file.moduleId)) ?? 0)
				: 0;
		const long = shuffled
			.filter((file) => seconds(file) >= LONG_NATIVE_FILE_SECONDS)
			.sort((left, right) => seconds(right) - seconds(left));
		return Promise.resolve([
			...long,
			...shuffled.filter((file) => seconds(file) < LONG_NATIVE_FILE_SECONDS),
		]);
	}
}

export default defineConfig({
	test: {
		watch: false,
		coverage: {
			provider: "v8",
		},
		fsModuleCache: true,
		fsModuleCachePath: ".cache/vitest",
		sequence: { shuffle: { files: true }, sequencer: LongNativeFilesFirst },

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
					maxWorkers: testWorkers,
					setupFiles: ["tests/setup-workers.ts"],
					isolate: false,
					sequence: {
						// Distinct groupOrder per project: vitest requires it when projects
						// differ in maxWorkers. The fast unit lane runs first (group 0).
						groupOrder: 0,
						// Stateful tests share a worker realm and must run serially within each file.
						concurrent: false,
						shuffle: { tests: true },
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
					// Which file first builds a runtime variant depends on scheduling and
					// sharding, so tests and hooks get the cold-build budget; runToStdout
					// deadlines still bound every child execution.
					testTimeout: 1_200_000,
					hookTimeout: 1_200_000,
				},
			},
		],
	},
});
