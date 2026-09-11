import { readFileSync } from "node:fs";
import * as path from "node:path";
import { CommandProgress } from "../src/command-progress.ts";
import { workerBudget, workerEnvironment } from "../src/worker-budget.ts";
import {
	assertLoopbackAvailable,
	testSelectionRequiresLoopback,
} from "./test-environment.ts";
import { runTestProcess } from "./test-process.ts";

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
const arguments_ = userArguments.some(
	(argument) => argument === "--configLoader" || argument.startsWith("--configLoader="),
)
	? userArguments
	: ["--configLoader", "runner", ...userArguments];
const progress = new CommandProgress("vitest");
progress.start(arguments_.length === 0 ? "watch all projects" : arguments_.join(" "));
progress.stage(1, 1, "run tests");

const budget = workerBudget(process.env.MALIGATOR_WORKERS);
const environment: NodeJS.ProcessEnv = {
	...workerEnvironment(budget),
	...process.env,
	MALIGATOR_WORKERS: String(budget),
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
