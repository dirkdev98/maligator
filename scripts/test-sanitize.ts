import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function sanitizerEnvironment(platform: NodeJS.Platform): NodeJS.ProcessEnv {
	return platform === "darwin" ? { MAL_UBSAN: "1" } : { MAL_ASAN: "1" };
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
			env: { ...process.env, ...selected },
		},
	);
	if (result.error !== undefined) throw result.error;
	return result.status ?? 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = runSanitizerTests();
}
