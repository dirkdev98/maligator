import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import * as path from "node:path";
import type { NativeBuildContext } from "./native-build-context.ts";
import { buildWorkerCount } from "./worker-budget.ts";

const DEFAULT_NATIVE_BUILD_JOBS = 8;
let resourceReportSerial = 0;

export interface NativeCommandOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	verbose: boolean;
	measureResources?: boolean;
}

export interface NativeCommand {
	tool: string;
	args: ReadonlyArray<string>;
}

export interface NativeCommandMeasurement {
	durationMs: number;
	userCpuMs: number;
	systemCpuMs: number;
	peakRssBytes?: number;
}

export function nativeBuildJobs(environment: NodeJS.ProcessEnv): number {
	return buildWorkerCount(environment, "MAL_BUILD_JOBS", DEFAULT_NATIVE_BUILD_JOBS);
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

function resourceReportPath(context: NativeBuildContext): string {
	return path.join(
		context.cacheDirectory,
		`.native-resource-${process.pid}-${resourceReportSerial++}.txt`,
	);
}

function timeArguments(reportPath: string, command: NativeCommand): Array<string> {
	return process.platform === "darwin"
		? ["-l", "-o", reportPath, command.tool, ...command.args]
		: ["-v", "-o", reportPath, command.tool, ...command.args];
}

function durationSeconds(value: string): number {
	const parts = value.split(":").map(Number);
	if (parts.some((part) => !Number.isFinite(part))) return Number.NaN;
	if (parts.length === 1) return parts[0]!;
	if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
	if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
	return Number.NaN;
}

function readResourceReport(reportPath: string, tool: string): NativeCommandMeasurement {
	const report = readFileSync(reportPath, "utf8");
	const timing =
		process.platform === "darwin"
			? report.match(
					/(^|\n)\s*([0-9.]+)\s+real\s+([0-9.]+)\s+user\s+([0-9.]+)\s+sys(?:\n|$)/,
				)
			: undefined;
	const elapsedSeconds =
		process.platform === "darwin"
			? Number(timing?.[2])
			: durationSeconds(
					report.match(
						/Elapsed \(wall clock\) time \(h:mm:ss or m:ss\):\s*([^\n]+)/,
					)?.[1] ?? "",
				);
	const userSeconds =
		process.platform === "darwin"
			? Number(timing?.[3])
			: Number(report.match(/User time \(seconds\):\s*([0-9.]+)/)?.[1]);
	const systemSeconds =
		process.platform === "darwin"
			? Number(timing?.[4])
			: Number(report.match(/System time \(seconds\):\s*([0-9.]+)/)?.[1]);
	if (![elapsedSeconds, userSeconds, systemSeconds].every(Number.isFinite)) {
		throw new Error(`native resource measurement omitted timing for ${tool}`);
	}
	const rssMatch =
		process.platform === "darwin"
			? report.match(/(^|\n)\s*([0-9]+)\s+maximum resident set size(?:\n|$)/)
			: report.match(/Maximum resident set size \(kbytes\):\s*([0-9]+)/);
	const rawRss = Number(rssMatch?.[process.platform === "darwin" ? 2 : 1]);
	return {
		durationMs: elapsedSeconds * 1000,
		userCpuMs: userSeconds * 1000,
		systemCpuMs: systemSeconds * 1000,
		...(Number.isSafeInteger(rawRss) && rawRss > 0
			? { peakRssBytes: process.platform === "darwin" ? rawRss : rawRss * 1024 }
			: {}),
	};
}

function reportMeasurement(
	context: NativeBuildContext,
	command: NativeCommand,
	options: NativeCommandOptions,
	measurement: NativeCommandMeasurement,
): void {
	context.onCommandResource?.({
		tool: command.tool,
		args: command.args,
		cwd: options.cwd,
		...measurement,
	});
}

function measuredCommand(
	context: NativeBuildContext,
	command: NativeCommand,
	options: NativeCommandOptions,
): NativeCommandMeasurement {
	const reportPath = resourceReportPath(context);
	let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	let failure:
		| (Error & { status?: number | null; stdout?: Buffer; stderr?: Buffer })
		| undefined;
	try {
		stdout = execFileSync("/usr/bin/time", timeArguments(reportPath, command), {
			cwd: options.cwd,
			env: options.env ?? context.environment,
			maxBuffer: 64 * 1024 * 1024,
			stdio: options.verbose ? ["pipe", "pipe", "inherit"] : "pipe",
		});
	} catch (error) {
		failure = error as typeof failure;
		stdout = failure?.stdout ?? stdout;
	}
	let measurement: NativeCommandMeasurement;
	try {
		measurement = readResourceReport(reportPath, command.tool);
	} finally {
		rmSync(reportPath, { force: true });
	}
	reportMeasurement(context, command, options, measurement);
	if (failure !== undefined) {
		const stderr = (failure.stderr ?? Buffer.alloc(0)).toString();
		throw new Error(
			`${command.tool} failed (${String(failure.status)}):\n${stdout.toString()}\n${stderr}`,
		);
	}
	if (options.verbose) {
		if (stdout.length > 0) process.stderr.write(stdout);
	}
	return measurement;
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
): NativeCommandMeasurement | undefined {
	const command = { tool, args };
	context.onCommand?.({ ...command, cwd: options.cwd });
	if (context.measureCommandResources || options.measureResources === true) {
		return measuredCommand(context, command, options);
	}
	const stdout = execFileSync(tool, [...args], {
		cwd: options.cwd,
		env: options.env ?? context.environment,
		stdio: options.verbose ? ["ignore", "pipe", "inherit"] : "pipe",
	});
	if (options.verbose && stdout.length > 0) process.stderr.write(stdout);
	return undefined;
}

/** Run independent native commands in bounded POSIX-shell batches. */
export function runNativeCommands(
	context: NativeBuildContext,
	commands: ReadonlyArray<NativeCommand>,
	options: NativeCommandOptions,
): Array<NativeCommandMeasurement | undefined> {
	if (commands.length === 0) return [];
	const jobs = Math.min(
		commands.length,
		nativeBuildJobs(options.env ?? context.environment),
	);
	if (jobs === 1) {
		return commands.map((command) =>
			runNativeCommand(context, command.tool, command.args, options),
		);
	}

	for (const command of commands) {
		context.onCommand?.({ tool: command.tool, args: command.args, cwd: options.cwd });
	}
	if (context.measureCommandResources || options.measureResources === true) {
		const reportPaths = commands.map(() => resourceReportPath(context));
		try {
			const timedCommands = commands.map((command, index) => ({
				tool: "/usr/bin/time",
				args: timeArguments(reportPaths[index]!, command),
			}));
			const stdout = execFileSync("/bin/sh", [], {
				cwd: options.cwd,
				env: options.env ?? context.environment,
				input: parallelShellScript(timedCommands, jobs),
				stdio: options.verbose ? ["pipe", "pipe", "inherit"] : "pipe",
			});
			if (options.verbose && stdout.length > 0) process.stderr.write(stdout);
			return commands.map((command, index) => {
				const measurement = readResourceReport(reportPaths[index]!, command.tool);
				reportMeasurement(context, command, options, measurement);
				return measurement;
			});
		} finally {
			for (const reportPath of reportPaths) rmSync(reportPath, { force: true });
		}
	}
	const stdout = execFileSync("/bin/sh", [], {
		cwd: options.cwd,
		env: options.env ?? context.environment,
		input: parallelShellScript(commands, jobs),
		stdio: options.verbose ? ["pipe", "pipe", "inherit"] : "pipe",
	});
	if (options.verbose && stdout.length > 0) process.stderr.write(stdout);
	return commands.map(() => undefined);
}
