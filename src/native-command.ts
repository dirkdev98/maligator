import { execFileSync } from "node:child_process";
import type { NativeBuildContext } from "./native-build-context.ts";

const DEFAULT_NATIVE_BUILD_JOBS = 8;

export interface NativeCommandOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	verbose: boolean;
}

export interface NativeCommand {
	tool: string;
	args: ReadonlyArray<string>;
}

/** Bound compiler fan-out while allowing constrained builders to opt down. */
export function nativeBuildJobs(environment: NodeJS.ProcessEnv): number {
	const configured = environment.MAL_BUILD_JOBS;
	if (configured === undefined || configured === "") return DEFAULT_NATIVE_BUILD_JOBS;
	if (!/^\d+$/.test(configured) || Number(configured) < 1) {
		throw new Error("MAL_BUILD_JOBS must be a positive integer");
	}
	return Number(configured);
}

function shellQuote(argument: string): string {
	return `'${argument.replaceAll("'", `'\\''`)}'`;
}

function shellCommand(command: NativeCommand): string {
	return [command.tool, ...command.args].map(shellQuote).join(" ");
}

function parallelShellScript(
	commands: ReadonlyArray<NativeCommand>,
	jobs: number,
): string {
	const workers = Array.from({ length: jobs }, () => new Array<NativeCommand>());
	for (const [index, command] of commands.entries()) workers[index % jobs]!.push(command);
	const starts = workers.map((worker, index) => {
		const body = worker
			.map((command) => `${shellCommand(command)} || exit $?`)
			.join("\n");
		return `(\n${body}\n) & p${index}=$!`;
	});
	const waits = workers.map((_worker, index) => `wait "$p${index}" || status=$?`);
	return `${starts.join("\n")}\nstatus=0\n${waits.join("\n")}\nexit "$status"\n`;
}

/** Execute independent commands concurrently through one synchronous coordinator. */
export function runIndependentCommands(
	commands: ReadonlyArray<NativeCommand>,
	options: NativeCommandOptions & { jobs: number },
): void {
	if (commands.length === 0) return;
	const jobs = Math.min(commands.length, options.jobs);
	if (jobs <= 1) {
		for (const command of commands) {
			execFileSync(command.tool, [...command.args], {
				cwd: options.cwd,
				env: options.env,
				stdio: options.verbose ? "inherit" : "pipe",
			});
		}
		return;
	}
	execFileSync("/bin/sh", [], {
		cwd: options.cwd,
		env: options.env,
		input: parallelShellScript(commands, jobs),
		stdio: options.verbose ? ["pipe", "inherit", "inherit"] : "pipe",
	});
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

/** Run independent native commands in bounded POSIX-shell batches. */
export function runNativeCommands(
	context: NativeBuildContext,
	commands: ReadonlyArray<NativeCommand>,
	options: NativeCommandOptions,
): void {
	if (commands.length === 0) return;
	const jobs = Math.min(
		commands.length,
		nativeBuildJobs(options.env ?? context.environment),
	);
	if (jobs === 1) {
		for (const command of commands) {
			runNativeCommand(context, command.tool, command.args, options);
		}
		return;
	}

	for (const command of commands) {
		context.onCommand?.({ tool: command.tool, args: command.args, cwd: options.cwd });
	}
	const stdout = execFileSync("/bin/sh", [], {
		cwd: options.cwd,
		env: options.env ?? context.environment,
		input: parallelShellScript(commands, jobs),
		stdio: options.verbose ? ["pipe", "pipe", "inherit"] : "pipe",
	});
	if (options.verbose && stdout.length > 0) process.stderr.write(stdout);
}
