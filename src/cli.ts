export { MALIGATOR_VERSION } from "./version.ts";

export interface InternalBuildOptions {
	name?: string;
	serializePath?: string;
	emitC: boolean;
	verbose: boolean;
	compiled: boolean;
	dumpLiveness: boolean;
	dumpInline: boolean;
	dumpHof: boolean;
	dumpSpeculative: boolean;
	dumpMethods: boolean;
	dumpEscape: boolean;
	dumpStackAlloc: boolean;
}

export interface BuildCommand {
	kind: "build";
	entry?: string;
	configPath?: string;
	target?: string;
	artifactDirectory?: string;
	production: boolean;
	internal: InternalBuildOptions;
}

export interface RunCommand {
	kind: "run";
	entry?: string;
	configPath?: string;
	programArgs: Array<string>;
}

export interface TestCommand {
	kind: "test";
	paths: Array<string>;
	configPath?: string;
	nameFilter?: string;
	shuffle?: true | number;
	repeat: number;
	bail: boolean;
	timeoutMs: number;
	compileConcurrency: number;
}

export type CliCommand =
	| { kind: "help" }
	| { kind: "version" }
	| { kind: "init" }
	| { kind: "doctor"; verbose: boolean; target?: string }
	| BuildCommand
	| RunCommand
	| TestCommand;

export class CliUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CliUsageError";
	}
}

export const CLI_HELP = `Usage: maligator <command> [options]

Commands:
  init                         Create maligator.build.ts
  doctor                       Check native build toolchains
  build [entry]                Compile an application
  run [entry] [-- args...]     Compile and run an application
  test [path ...]              Discover and interpret tests

Options:
  --config <path>              Use an explicit build configuration
  --target <rust-triple>       Cross-build through Zig (build and doctor)
  --production                 Build with production optimizations
  --artifact <directory>       Create a deployable production artifact
  --run <name>                 Filter tests by hierarchical name
  --shuffle [seed]             Shuffle deterministically and print the seed
  --repeat <count>             Repeat selected tests without recompiling
  --bail                       Stop after the first failure
  -h, --help                   Show help
  -V, --version                Show the version`;

function optionValue(args: Array<string>, index: number, option: string): string {
	const value = args[index + 1];
	if (value === undefined || value.startsWith("-")) {
		throw new CliUsageError(`option '${option}' requires a value`);
	}
	return value;
}

function unexpectedArgument(command: string, argument: string): never {
	if (argument.startsWith("-")) {
		throw new CliUsageError(`unknown option '${argument}' for '${command}'`);
	}
	throw new CliUsageError(`unexpected argument '${argument}' for '${command}'`);
}

function parseSimpleCommand(kind: "init" | "doctor", args: Array<string>): CliCommand {
	if (kind === "init") {
		if (args.length === 1) return { kind };
		if (args.length === 2 && (args[1] === "--help" || args[1] === "-h")) {
			return { kind: "help" };
		}
		return unexpectedArgument(kind, args[1]!);
	}
	const command: Extract<CliCommand, { kind: "doctor" }> = {
		kind: "doctor",
		verbose: false,
	};
	for (let index = 1; index < args.length; index++) {
		const argument = args[index]!;
		if (argument === "--help" || argument === "-h") return { kind: "help" };
		if (argument === "--verbose") {
			command.verbose = true;
			continue;
		}
		if (argument === "--target") {
			command.target = optionValue(args, index, argument);
			index++;
			continue;
		}
		return unexpectedArgument(kind, argument);
	}
	return command;
}

function parseBuild(args: Array<string>): CliCommand {
	const command: BuildCommand = {
		kind: "build",
		production: false,
		internal: {
			emitC: false,
			verbose: false,
			compiled: true,
			dumpLiveness: false,
			dumpInline: false,
			dumpHof: false,
			dumpSpeculative: false,
			dumpMethods: false,
			dumpEscape: false,
			dumpStackAlloc: false,
		},
	};

	for (let index = 1; index < args.length; index++) {
		const argument = args[index]!;
		if (argument === "--help" || argument === "-h") {
			return { kind: "help" };
		}
		if (argument === "--") {
			const trailing = args[index + 1];
			throw new CliUsageError(
				trailing === undefined
					? "'--' is only valid for 'maligator run'"
					: `unexpected argument '${trailing}' for 'build'`,
			);
		}
		if (argument === "--config") {
			command.configPath = optionValue(args, index, argument);
			index++;
			continue;
		}
		if (argument === "--production") {
			command.production = true;
			continue;
		}
		if (argument === "--target") {
			command.target = optionValue(args, index, argument);
			index++;
			continue;
		}
		if (argument === "--artifact") {
			command.artifactDirectory = optionValue(args, index, argument);
			index++;
			continue;
		}
		if (argument === "--name") {
			command.internal.name = optionValue(args, index, argument);
			index++;
			continue;
		}
		if (argument === "--serialize") {
			command.internal.serializePath = optionValue(args, index, argument);
			index++;
			continue;
		}
		if (argument === "--emit-c" || argument === "--print") {
			command.internal.emitC = true;
			continue;
		}
		if (argument === "--verbose") {
			command.internal.verbose = true;
			continue;
		}
		if (argument === "--no-compiled") {
			command.internal.compiled = false;
			continue;
		}
		if (argument === "--dump-liveness") {
			command.internal.dumpLiveness = true;
			continue;
		}
		if (argument === "--dump-inline") {
			command.internal.dumpInline = true;
			continue;
		}
		if (argument === "--dump-hof") {
			command.internal.dumpHof = true;
			continue;
		}
		if (argument === "--dump-speculative") {
			command.internal.dumpSpeculative = true;
			continue;
		}
		if (argument === "--dump-methods") {
			command.internal.dumpMethods = true;
			continue;
		}
		if (argument === "--dump-escape") {
			command.internal.dumpEscape = true;
			continue;
		}
		if (argument === "--dump-stack-alloc") {
			command.internal.dumpStackAlloc = true;
			continue;
		}
		if (argument === "--run") {
			throw new CliUsageError("unknown option '--run' for 'build'; use 'maligator run'");
		}
		if (argument.startsWith("-")) {
			return unexpectedArgument("build", argument);
		}
		if (command.entry !== undefined) {
			return unexpectedArgument("build", argument);
		}
		command.entry = argument;
	}

	return command;
}

function parseRun(args: Array<string>): CliCommand {
	const command: RunCommand = {
		kind: "run",
		programArgs: [],
	};

	for (let index = 1; index < args.length; index++) {
		const argument = args[index]!;
		if (argument === "--help" || argument === "-h") {
			return { kind: "help" };
		}
		if (argument === "--") {
			command.programArgs = args.slice(index + 1);
			return command;
		}
		if (argument === "--config") {
			command.configPath = optionValue(args, index, argument);
			index++;
			continue;
		}
		if (argument.startsWith("-")) {
			return unexpectedArgument("run", argument);
		}
		if (command.entry !== undefined) {
			return unexpectedArgument("run", argument);
		}
		command.entry = argument;
	}

	return command;
}

function positiveInteger(value: string, option: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new CliUsageError(`option '${option}' requires a positive integer`);
	}
	return parsed;
}

function parseTest(args: Array<string>): CliCommand {
	const command: TestCommand = {
		kind: "test",
		paths: [],
		repeat: 1,
		bail: false,
		timeoutMs: 5000,
		compileConcurrency: 1,
	};

	for (let index = 1; index < args.length; index++) {
		const argument = args[index]!;
		if (argument === "--help" || argument === "-h") return { kind: "help" };
		if (argument === "--config") {
			command.configPath = optionValue(args, index, argument);
			index++;
			continue;
		}
		if (argument === "--run") {
			command.nameFilter = optionValue(args, index, argument);
			index++;
			continue;
		}
		if (argument === "--shuffle") {
			const seed = args[index + 1];
			if (seed !== undefined && !seed.startsWith("-")) {
				command.shuffle = positiveInteger(seed, argument);
				index++;
			} else {
				command.shuffle = true;
			}
			continue;
		}
		if (argument === "--repeat") {
			command.repeat = positiveInteger(optionValue(args, index, argument), argument);
			index++;
			continue;
		}
		if (argument === "--timeout") {
			command.timeoutMs = positiveInteger(optionValue(args, index, argument), argument);
			index++;
			continue;
		}
		if (argument === "--compile-concurrency") {
			command.compileConcurrency = positiveInteger(
				optionValue(args, index, argument),
				argument,
			);
			index++;
			continue;
		}
		if (argument === "--bail") {
			command.bail = true;
			continue;
		}
		if (argument.startsWith("-")) return unexpectedArgument("test", argument);
		command.paths.push(argument);
	}
	return command;
}

export function parseCliArgs(args: Array<string>): CliCommand {
	const command = args[0];
	if (command === undefined) {
		throw new CliUsageError("missing command");
	}
	if (command === "--help" || command === "-h" || command === "help") {
		if (args.length > 1) {
			return unexpectedArgument("help", args[1]!);
		}
		return { kind: "help" };
	}
	if (command === "--version" || command === "-V") {
		if (args.length > 1) {
			return unexpectedArgument("version", args[1]!);
		}
		return { kind: "version" };
	}
	if (command === "init" || command === "doctor") {
		return parseSimpleCommand(command, args);
	}
	if (command === "build") {
		return parseBuild(args);
	}
	if (command === "run") {
		return parseRun(args);
	}
	if (command === "test") {
		return parseTest(args);
	}

	const suggestion = command.startsWith("-")
		? `unknown option '${command}'`
		: `unknown command '${command}'`;
	throw new CliUsageError(`${suggestion}; expected init, doctor, build, run, or test`);
}
