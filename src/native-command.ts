import { execFileSync } from "node:child_process";
import type { NativeBuildContext } from "./native-build-context.ts";

export interface NativeCommandOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	verbose: boolean;
}

/** Run one native tool while keeping the CLI's result-only stdout contract. */
export function runNativeCommand(
	context: NativeBuildContext,
	tool: string,
	args: ReadonlyArray<string>,
	options: NativeCommandOptions,
): void {
	context.onCommand?.({ tool, args, cwd: options.cwd });
	const stdout = execFileSync(tool, [...args], {
		cwd: options.cwd,
		env: options.env ?? context.environment,
		stdio: options.verbose ? ["ignore", "pipe", "inherit"] : "pipe",
	});
	if (options.verbose && stdout.length > 0) process.stderr.write(stdout);
}
