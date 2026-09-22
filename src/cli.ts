export { MALIGATOR_VERSION } from "./version.ts";

export interface InternalBuildOptions {
	name?: string;
	serializePath?: string;
	emitC: boolean;
	verbose: boolean;
	compiled: boolean;
	dumpCore: boolean;
}

export interface BuildCommand {
	pgoTrain?: boolean;
	pgoUse?: string;
	pgoWorkload?: string;
	kind: "build";
	entry?: string;
	configPath?: string;
	target?: string;
	artifactDirectory?: string;
	production: boolean;
	profile: boolean;
	profileCompiler?: boolean;
	internal: InternalBuildOptions;
}

export interface RunCommand {
	pgoTrain?: boolean;
	pgoUse?: string;
	pgoWorkload?: string;
	kind: "run";
	entry?: string;
	configPath?: string;
	verbose: boolean;
	profile: boolean;
	profileCompiler?: boolean;
	programArgs: Array<string>;
}

export interface DevCommand {
	pgoTrain?: boolean;
	pgoUse?: string;
	pgoWorkload?: string;
	kind: "dev";
	entry?: string;
	configPath?: string;
	verbose: boolean;
	profile: boolean;
	profileCompiler?: boolean;
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
	profile: boolean;
	profileCompiler?: boolean;
}

export interface CacheCommand {
	kind: "cache";
	action: "status" | "prune" | "clear";
	dryRun: boolean;
	verbose: boolean;
	maxBytes?: number;
	minAgeMs?: number;
}

export type CliCommand =
	| { kind: "pgo-merge"; inputs: Array<string>; output?: string }
	| { kind: "help" }
	| { kind: "version" }
	| { kind: "init" }
	| { kind: "doctor"; verbose: boolean; target?: string }
	| CacheCommand
	| BuildCommand
	| RunCommand
	| DevCommand
	| TestCommand;

export class CliUsageError extends Error {
	constructor(message: string) {
		super(message);
		Object.defineProperty(this, "name", { value: "CliUsageError", configurable: true });
	}
}

export const CLI_HELP = `Usage: maligator <command> [options]

Commands:
  pgo merge <captures...>      Merge explicit completed training captures
  init                         Create maligator.build.ts
  doctor                       Check native build toolchains
  cache status                 Show Maligator-owned cache usage
  cache prune                  Remove stale rebuildable cache entries
  cache clear --all            Remove every rebuildable cache entry
  build [entry]                Compile an application
  run [entry] [-- args...]     Compile and run an application
  dev [entry] [-- args...]     Watch, rebuild, and restart an application
  test [path ...]              Discover and interpret tests

Options:
  --config <path>              Use an explicit build configuration
  --target <rust-triple>       Cross-build through Zig (build and doctor)
  --production                 Build with production optimizations
  --profile[=compiler]         Sample production code, or add exact compiler counters
  --pgo-use <profile>    Use a validated merged PGO profile for optimization
  --pgo-train                  Build or run with compact VM training counters
  --pgo-workload <name>        Label a training run (run only)
  --out <path>                Select the merged profile output (pgo merge)
  --artifact <directory>       Create a deployable production artifact
  --verbose                    Show build diagnostics or every pruned cache entry
  --run <name>                 Filter tests by hierarchical name
  --shuffle [seed]             Shuffle deterministically and print the seed
  --repeat <count>             Repeat selected tests without recompiling
  --bail                       Stop after the first failure
  --max-gb <number>            Cache prune target in GiB (default: 15)
  --min-age-days <number>      Youngest cache age eligible for prune (default: 1)
  --dry-run                    Show what cache prune would remove
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
		profile: false,
		internal: {
			emitC: false,
			verbose: false,
			compiled: true,
			dumpCore: false,
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
					? "'--' is only valid for 'maligator run' or 'maligator dev'"
					: `unexpected argument '${trailing}' for 'build'`,
			);
		}
		if (argument === "--config") {
			command.configPath = optionValue(args, index, argument);
			index++;
			continue;
		}
		if (argument === "--pgo-use") {
			command.pgoUse = optionValue(args, index++, argument);
			continue;
		}
		if (argument === "--pgo-train") {
			command.pgoTrain = true;
			continue;
		}
		if (argument === "--production") {
			command.production = true;
			continue;
		}
		if (argument === "--profile" || argument === "--profile=compiler") {
			command.profile = true;
			if (argument === "--profile=compiler") command.profileCompiler = true;
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
		if (argument === "--render-native-c" || argument === "--print") {
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
		if (argument === "--dump-core") {
			command.internal.dumpCore = true;
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

	return validatePgoTraining(command);
}

function parseRun(args: Array<string>, kind: "run" | "dev"): CliCommand {
	const command: RunCommand | DevCommand = {
		kind,
		verbose: false,
		profile: false,
		programArgs: [],
	};

	for (let index = 1; index < args.length; index++) {
		const argument = args[index]!;
		if (argument === "--help" || argument === "-h") {
			return { kind: "help" };
		}
		if (argument === "--") {
			command.programArgs = args.slice(index + 1);
			return validatePgoTraining(command);
		}
		if (argument === "--config") {
			command.configPath = optionValue(args, index, argument);
			index++;
			continue;
		}
		if (kind === "run" && argument === "--pgo-use") {
			command.pgoUse = optionValue(args, index++, argument);
			continue;
		}
		if (kind === "run" && argument === "--pgo-train") {
			command.pgoTrain = true;
			continue;
		}
		if (kind === "run" && argument === "--pgo-workload") {
			command.pgoWorkload = optionValue(args, index++, argument);
			continue;
		}
		if (argument === "--verbose") {
			command.verbose = true;
			continue;
		}
		if (argument === "--profile" || argument === "--profile=compiler") {
			command.profile = true;
			if (argument === "--profile=compiler") command.profileCompiler = true;
			continue;
		}
		if (argument.startsWith("-")) {
			return unexpectedArgument(kind, argument);
		}
		if (command.entry !== undefined) {
			return unexpectedArgument(kind, argument);
		}
		command.entry = argument;
	}

	return validatePgoTraining(command);
}

function positiveInteger(value: string, option: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new CliUsageError(`option '${option}' requires a positive integer`);
	}
	return parsed;
}

function positiveNumber(value: string, option: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new CliUsageError(`option '${option}' requires a positive number`);
	}
	return parsed;
}

function parseCache(args: Array<string>): CliCommand {
	const action = args[1];
	if (action === "--help" || action === "-h") return { kind: "help" };
	if (action !== "status" && action !== "prune" && action !== "clear") {
		throw new CliUsageError("cache requires 'status', 'prune', or 'clear'");
	}
	let clearConfirmed = false;
	const command: CacheCommand = {
		kind: "cache",
		action,
		dryRun: false,
		verbose: false,
	};
	for (let index = 2; index < args.length; index++) {
		const argument = args[index]!;
		if (argument === "--help" || argument === "-h") return { kind: "help" };
		if (action === "clear" && argument === "--all") {
			clearConfirmed = true;
			continue;
		}
		if (action === "prune" && argument === "--dry-run") {
			command.dryRun = true;
			continue;
		}
		if (action === "prune" && argument === "--verbose") {
			command.verbose = true;
			continue;
		}
		if (action === "prune" && argument === "--max-gb") {
			command.maxBytes =
				positiveNumber(optionValue(args, index, argument), argument) * 1024 ** 3;
			index++;
			continue;
		}
		if (action === "prune" && argument === "--min-age-days") {
			command.minAgeMs =
				positiveNumber(optionValue(args, index, argument), argument) *
				24 *
				60 *
				60 *
				1000;
			index++;
			continue;
		}
		return unexpectedArgument(`cache ${action}`, argument);
	}
	if (action === "clear" && !clearConfirmed) {
		throw new CliUsageError("cache clear requires '--all'");
	}
	return command;
}

function parseTest(args: Array<string>): CliCommand {
	const command: TestCommand = {
		kind: "test",
		paths: [],
		repeat: 1,
		bail: false,
		timeoutMs: 5000,
		compileConcurrency: 1,
		profile: false,
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
		if (argument === "--profile" || argument === "--profile=compiler") {
			command.profile = true;
			if (argument === "--profile=compiler") command.profileCompiler = true;
			continue;
		}
		if (argument.startsWith("-")) return unexpectedArgument("test", argument);
		command.paths.push(argument);
	}
	return command;
}

function validatePgoTraining<T extends BuildCommand | RunCommand | DevCommand>(
	command: T,
): T {
	if (command.pgoTrain && command.pgoUse !== undefined)
		throw new CliUsageError("PGO training and profile use are mutually exclusive");
	if (command.pgoTrain && command.profile)
		throw new CliUsageError("PGO training and diagnostic profiling are separate modes");
	if (command.pgoWorkload !== undefined && !command.pgoTrain)
		throw new CliUsageError("--pgo-workload requires --pgo-train");
	if (
		command.pgoTrain &&
		command.kind === "build" &&
		(command.internal.serializePath !== undefined ||
			command.artifactDirectory !== undefined)
	)
		throw new CliUsageError("PGO training currently supports local native binaries only");
	return command;
}

function parsePgo(args: Array<string>): CliCommand {
	if (args[1] !== "merge") throw new CliUsageError("expected pgo merge <captures...>");
	const command: Extract<CliCommand, { kind: "pgo-merge" }> = {
		kind: "pgo-merge",
		inputs: [],
	};
	for (let index = 2; index < args.length; index++) {
		const argument = args[index]!;
		if (argument === "--out") command.output = optionValue(args, index++, argument);
		else if (argument.startsWith("-")) return unexpectedArgument("pgo merge", argument);
		else command.inputs.push(argument);
	}
	if (command.inputs.length === 0)
		throw new CliUsageError("PGO merge needs explicit captures");
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
		return parseRun(args, "run");
	}
	if (command === "dev") {
		return parseRun(args, "dev");
	}
	if (command === "test") {
		return parseTest(args);
	}
	if (command === "pgo") return parsePgo(args);
	if (command === "cache") {
		return parseCache(args);
	}

	const suggestion = command.startsWith("-")
		? `unknown option '${command}'`
		: `unknown command '${command}'`;
	throw new CliUsageError(
		`${suggestion}; expected init, doctor, cache, build, run, dev, or test`,
	);
}
