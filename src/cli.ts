export const MALIGATOR_VERSION = "0.0.1";

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
	production: boolean;
	internal: InternalBuildOptions;
}

export interface RunCommand {
	kind: "run";
	entry?: string;
	configPath?: string;
	programArgs: Array<string>;
}

export type CliCommand =
	| { kind: "help" }
	| { kind: "version" }
	| { kind: "init" }
	| { kind: "doctor"; verbose: boolean }
	| BuildCommand
	| RunCommand;

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

Options:
  --config <path>              Use an explicit build configuration
  --production                 Build with production optimizations
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
	if (args.length === 1) {
		return kind === "doctor" ? { kind, verbose: false } : { kind };
	}
	if (args.length === 2 && (args[1] === "--help" || args[1] === "-h")) {
		return { kind: "help" };
	}
	if (kind === "doctor" && args.length === 2 && args[1] === "--verbose") {
		return { kind, verbose: true };
	}
	return unexpectedArgument(kind, args[1]!);
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

	const suggestion = command.startsWith("-")
		? `unknown option '${command}'`
		: `unknown command '${command}'`;
	throw new CliUsageError(`${suggestion}; expected init, doctor, build, or run`);
}
