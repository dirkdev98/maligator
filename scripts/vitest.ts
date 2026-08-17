import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { CommandProgress } from "../src/command-progress.ts";
import {
	assertLoopbackAvailable,
	testSelectionRequiresLoopback,
} from "./test-environment.ts";

const FULL_ONLY_ARGUMENT = "--maligator-unit-full-only";
const userArguments = process.argv
	.slice(2)
	.filter((argument) => argument !== FULL_ONLY_ARGUMENT);
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

const environment = { ...process.env };
if (runFullOnlyUnitTests) environment.MAL_TEST_UNIT_FULL_ONLY = "1";
else delete environment.MAL_TEST_UNIT_FULL_ONLY;
const result = spawnSync(path.resolve("node_modules/.bin/vitest"), arguments_, {
	stdio: "inherit",
	env: environment,
});
if (result.error !== undefined) throw result.error;
if (result.status === 0) {
	progress.stagePassed(1, 1, "run tests");
	progress.complete();
} else {
	progress.stageFailed(1, 1, "run tests");
	progress.failed();
	if (result.signal !== null) process.kill(process.pid, result.signal);
	process.exitCode = result.status ?? 1;
}
