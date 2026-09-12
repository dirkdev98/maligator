import * as os from "node:os";
import { pathToFileURL } from "node:url";
import { CommandProgress } from "../src/command-progress.ts";
import { TEST_TELEMETRY_ENV } from "../src/test-telemetry.ts";
import { workerBudget, workerCount, workerEnvironment } from "../src/worker-budget.ts";
import {
	commandEnvironmentPlan,
	requirementsForCommand,
} from "./command-requirements.ts";
import { cleanTestEnvironment } from "./test-environment.ts";
import { runTestProcess } from "./test-process.ts";

export function sanitizerEnvironment(
	platform: NodeJS.Platform,
	environment: NodeJS.ProcessEnv = process.env,
	availableParallelism = os.availableParallelism(),
): NodeJS.ProcessEnv {
	const undefinedBehavior = "halt_on_error=1:print_stacktrace=1";
	const telemetry = environment[TEST_TELEMETRY_ENV];
	const budget = workerBudget(environment.MALIGATOR_WORKERS, availableParallelism);
	const workers = workerCount(
		environment.MAL_SANITIZER_WORKERS,
		"MAL_SANITIZER_WORKERS",
		Math.min(2, budget),
		budget,
	);
	const buildJobs = workerCount(
		environment.MAL_BUILD_JOBS,
		"MAL_BUILD_JOBS",
		budget,
		budget,
	);
	const preparationBuildJobs = workerCount(
		environment.MAL_PREPARATION_BUILD_JOBS,
		"MAL_PREPARATION_BUILD_JOBS",
		budget,
		budget,
	);
	const shared = {
		...workerEnvironment(budget),
		...(telemetry === undefined ? {} : { [TEST_TELEMETRY_ENV]: telemetry }),
		// Standalone runners otherwise leave VM reclamation to process exit.
		MAL_GC_AT_EXIT: "1",
		MAL_BUILD_JOBS: String(buildJobs),
		MAL_SANITIZER_WORKERS: String(workers),
		MAL_TEST_WORKERS: String(workers),
		MAL_PREPARATION_BUILD_JOBS: String(preparationBuildJobs),
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

export async function runSanitizerTests(args = process.argv.slice(2)): Promise<number> {
	const selected = sanitizerEnvironment(process.platform);
	const mode = selected.MAL_UBSAN === "1" ? "UBSan" : "ASan+UBSan";
	const keepArtifacts = args.includes("--keep-artifacts");
	const testArguments = args.filter((argument) => argument !== "--keep-artifacts");
	if (args.includes("--plan=json")) {
		console.log(
			JSON.stringify(
				{
					...commandEnvironmentPlan(requirementsForCommand("native")),
					mode,
					environment: selected,
					keepArtifacts,
					invocation: [
						process.execPath,
						"node_modules/vitest/vitest.mjs",
						"run",
						"--project",
						"native",
						...testArguments.filter((argument) => argument !== "--plan=json"),
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
	const status = await runTestProcess(
		process.execPath,
		["node_modules/vitest/vitest.mjs", "run", "--project", "native", ...testArguments],
		{
			environment: cleanTestEnvironment(selected),
			keepArtifacts,
		},
	);
	if (status === 0) {
		progress.stagePassed(1, 1, `${mode} native tests on ${process.platform}`);
		progress.complete();
	} else {
		progress.stageFailed(1, 1, `${mode} native tests on ${process.platform}`);
	}
	return status;
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	process.exitCode = await runSanitizerTests();
}
