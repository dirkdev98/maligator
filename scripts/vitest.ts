import { readFileSync } from "node:fs";
import * as path from "node:path";
import { CommandProgress } from "../src/command-progress.ts";
import {
	nestedTestWorkerAllocation,
	workerBudget,
	workerCount,
	workerEnvironment,
} from "../src/worker-budget.ts";
import {
	assertLoopbackAvailable,
	testSelectionRequiresLoopback,
} from "./test-environment.ts";
import { runTestProcess } from "./test-process.ts";
import { constrainVitestMaxWorkers } from "./vitest-arguments.ts";

const FULL_ONLY_ARGUMENT = "--maligator-unit-full-only";
const keepArtifacts = process.argv.includes("--keep-artifacts");
const userArguments = process.argv
	.slice(2)
	.filter(
		(argument) => argument !== FULL_ONLY_ARGUMENT && argument !== "--keep-artifacts",
	);
const runFullOnlyUnitTests = process.argv.includes(FULL_ONLY_ARGUMENT);
const loopbackTests = new Set(
	readFileSync("tests/test-suite-native-loopback.txt", "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#")),
);
if (testSelectionRequiresLoopback(userArguments, loopbackTests)) {
	try {
		await assertLoopbackAvailable();
	} catch (error) {
		console.error(`[vitest] ${error instanceof Error ? error.message : String(error)}`);
		process.exit(2);
	}
}
const budget = workerBudget(process.env.MALIGATOR_WORKERS);
const nativeProject = userArguments.some(
	(argument, index) =>
		argument === "--project=native" ||
		(argument === "--project" && userArguments[index + 1] === "native"),
);
const selectedTestFiles = userArguments.filter((argument) =>
	argument.endsWith(".test.ts"),
).length;
const plannedAllocation = nestedTestWorkerAllocation(
	budget,
	selectedTestFiles,
	nativeProject,
);
const testWorkers =
	process.env.MAL_TEST_WORKERS === undefined
		? plannedAllocation.testWorkers
		: Math.min(
				plannedAllocation.testWorkers,
				workerCount(
					process.env.MAL_TEST_WORKERS,
					"MAL_TEST_WORKERS",
					plannedAllocation.testWorkers,
					budget,
				),
			);
const allocatedArguments = nativeProject
	? constrainVitestMaxWorkers(userArguments, testWorkers)
	: userArguments;
const arguments_ = allocatedArguments.some(
	(argument) => argument === "--configLoader" || argument.startsWith("--configLoader="),
)
	? allocatedArguments
	: ["--configLoader", "runner", ...allocatedArguments];
const progress = new CommandProgress("vitest");
progress.start(arguments_.length === 0 ? "watch all projects" : arguments_.join(" "));
progress.stage(1, 1, "run tests");

const environment: NodeJS.ProcessEnv = {
	...workerEnvironment(budget),
	...process.env,
	MALIGATOR_WORKERS: String(budget),
	MAL_TEST_WORKERS: String(testWorkers),
	MAL_PREPARATION_BUILD_JOBS: process.env.MAL_PREPARATION_BUILD_JOBS ?? String(budget),
};
if (runFullOnlyUnitTests) environment.MAL_TEST_UNIT_FULL_ONLY = "1";
else delete environment.MAL_TEST_UNIT_FULL_ONLY;
const status = await runTestProcess(
	process.execPath,
	[path.resolve("node_modules/vitest/vitest.mjs"), ...arguments_],
	{
		environment,
		keepArtifacts,
	},
);
if (status === 0) {
	progress.stagePassed(1, 1, "run tests");
	progress.complete();
} else {
	progress.stageFailed(1, 1, "run tests");
	progress.failed();
	process.exitCode = status;
}
