import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { cleanTestEnvironment } from "./test-environment.ts";

export function sanitizerEnvironment(platform: NodeJS.Platform): NodeJS.ProcessEnv {
	const undefinedBehavior = "halt_on_error=1:print_stacktrace=1";
	return platform === "darwin"
		? { MAL_UBSAN: "1", UBSAN_OPTIONS: undefinedBehavior }
		: {
				MAL_ASAN: "1",
				ASAN_OPTIONS: "abort_on_error=1:detect_leaks=1:halt_on_error=1",
				UBSAN_OPTIONS: undefinedBehavior,
			};
}

export function runSanitizerTests(args = process.argv.slice(2)): number {
	const selected = sanitizerEnvironment(process.platform);
	const mode = selected.MAL_UBSAN === "1" ? "UBSan" : "ASan+UBSan";
	console.log(`sanitizer lane: ${mode} on ${process.platform}`);
	const result = spawnSync(
		process.execPath,
		["node_modules/vitest/vitest.mjs", "run", "--project", "native", ...args],
		{
			stdio: "inherit",
			env: cleanTestEnvironment(selected),
		},
	);
	if (result.error !== undefined) throw result.error;
	return result.status ?? 1;
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	process.exitCode = runSanitizerTests();
}
