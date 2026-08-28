import { spawnSync } from "node:child_process";
import * as os from "node:os";
import { pathToFileURL } from "node:url";
import { CommandProgress } from "../src/command-progress.ts";
import { TEST_TELEMETRY_ENV } from "../src/test-telemetry.ts";
import {
	commandEnvironmentPlan,
	requirementsForCommand,
} from "./command-requirements.ts";
import { cleanTestEnvironment } from "./test-environment.ts";

export function sanitizerEnvironment(
	platform: NodeJS.Platform,
	environment: NodeJS.ProcessEnv = process.env,
	availableParallelism = os.availableParallelism(),
): NodeJS.ProcessEnv {
	const undefinedBehavior = "halt_on_error=1:print_stacktrace=1";
	const telemetry = environment[TEST_TELEMETRY_ENV];
	const workers =
		environment.MAL_SANITIZER_WORKERS ?? String(Math.min(2, availableParallelism));
	const buildJobs =
		environment.MAL_BUILD_JOBS ??
		String(Math.max(1, Math.floor(availableParallelism / 2)));
	const shared = {
		...(telemetry === undefined ? {} : { [TEST_TELEMETRY_ENV]: telemetry }),
		MAL_BUILD_JOBS: buildJobs,
		MAL_SANITIZER_WORKERS: workers,
	};
	return platform === "darwin"
		? { ...shared, MAL_UBSAN: "1", UBSAN_OPTIONS: undefinedBehavior }
		: {
				...shared,
				MAL_ASAN: "1",
				ASAN_OPTIONS: "abort_on_error=1:detect_leaks=1:halt_on_error=1",
				UBSAN_OPTIONS: undefinedBehavior,
			};
}

export function runSanitizerTests(args = process.argv.slice(2)): number {
	const selected = sanitizerEnvironment(process.platform);
	const mode = selected.MAL_UBSAN === "1" ? "UBSan" : "ASan+UBSan";
	if (args.includes("--plan=json")) {
		console.log(
			JSON.stringify(
				{
					...commandEnvironmentPlan(requirementsForCommand("native")),
					mode,
					environment: selected,
					invocation: [
						process.execPath,
						"node_modules/vitest/vitest.mjs",
						"run",
						"--project",
						"native",
						...args.filter((argument) => argument !== "--plan=json"),
					],
				},
				null,
				2,
			),
		);
		return 0;
	}
	const progress = new CommandProgress("sanitize");
	progress.stage(1, 1, `${mode} native tests on ${process.platform}`);
	const result = spawnSync(
		process.execPath,
		["node_modules/vitest/vitest.mjs", "run", "--project", "native", ...args],
		{
			stdio: "inherit",
			env: cleanTestEnvironment(selected),
		},
	);
	if (result.error !== undefined) throw result.error;
	if (result.status === 0) {
		progress.stagePassed(1, 1, `${mode} native tests on ${process.platform}`);
		progress.complete();
	} else {
		progress.stageFailed(1, 1, `${mode} native tests on ${process.platform}`);
	}
	return result.status ?? 1;
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	process.exitCode = runSanitizerTests();
}
