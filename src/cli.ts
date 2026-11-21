export { MALIGATOR_VERSION } from "./version.ts";

import type { CoreInstrumentationMode } from "./compiler/core/core-optimization-report.ts";

export interface InternalBuildOptions {
	name?: string;
	serializePath?: string;
	emitC: boolean;
	verbose: boolean;
	compiled: boolean;
	dumpCore: boolean;
	coreReport?: CoreInstrumentationMode;
}

export interface BuildCommand {
	kind: "build";
	entry?: string;
	configPath?: string;
	target?: string;
	artifactDirectory?: string;
	production: boolean;
	compileConcurrency?: number;
	profile: boolean;
	profileCompiler?: boolean;
	internal: InternalBuildOptions;
}

export interface RunCommand {
	kind: "run";
	entry?: string;
	configPath?: string;
	verbose: boolean;
	profile: boolean;
	profileCompiler?: boolean;
	programArgs: Array<string>;
}

export interface DevCommand {
	kind: "dev";
	entry?: string;
	configPath?: string;
	verbose: boolean;
	status?: boolean;
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
	isolation?: "file";
	executionConcurrency?: number;
	watch?: boolean;
	watchFailed?: boolean;
	status?: boolean;
	verbose?: boolean;
	profile: boolean;
	profileCompiler?: boolean;
}

export interface CacheCommand {
	kind: "cache";
	action: "status" | "prune" | "clear" | "maintain";
	dryRun: boolean;
	verbose: boolean;
	maxBytes?: number;
	minAgeMs?: number;
}

export type FfiCommand = {
	kind: "ffi";
	configPath?: string;
	target?: string;
} & (
	| { action: "inspect"; library: string; json: boolean }
	| { action: "types"; outPath?: string }
	| {
			action: "check";
			library?: string;
			json: boolean;
			update: boolean;
			outPath?: string;
			probe?: { path: string; timeoutMs: number };
	  }
);

export type CliCommand =
	| { kind: "help"; command?: HelpCommand }
	| { kind: "version" }
	| { kind: "init" }
	| { kind: "doctor"; verbose: boolean; target?: string }
	| CacheCommand
	| FfiCommand
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

interface HelpRow {
	label: string;
	description: string;
	default?: number | string;
}

interface CliOption<Command> extends HelpRow {
	names: ReadonlyArray<string>;
	read(command: Command, args: Array<string>, index: number): number;
}

const HELP_OPTION = {
	names: ["--help", "-h"],
	label: "-h, --help",
	description: "Show help",
};
const VERSION_OPTION = {
	names: ["--version", "-V"],
	label: "-V, --version",
	description: "Show the version",
};

function optionValue(args: Array<string>, index: number, option: string): string {
	const value = args[index + 1];
	if (value === undefined || value.startsWith("-")) {
		throw new CliUsageError(`option '${option}' requires a value`);
	}
	return value;
}

function flag<Command>(
	name: string,
	description: string,
	apply: (command: Command, argument: string) => void,
	options?: { alias: string; label?: string },
): CliOption<Command> {
	return {
		names: options === undefined ? [name] : [name, options.alias],
		label: options?.label ?? (options === undefined ? name : `${name}, ${options.alias}`),
		description,
		read(command, args, index) {
			apply(command, args[index]!);
			return index;
		},
	};
}

function value<Command>(
	name: string,
	metavar: string,
	description: string,
	apply: (command: Command, value: string, argument: string) => void,
	options?: { default?: string | number; withoutValue?: (command: Command) => void },
): CliOption<Command> {
	return {
		names: [name],
		label: `${name} ${options?.withoutValue === undefined ? `<${metavar}>` : `[${metavar}]`}`,
		description,
		default: options?.default,
		read(command, args, index) {
			const next = args[index + 1];
			if (
				options?.withoutValue !== undefined &&
				(next === undefined || next.startsWith("-"))
			) {
				options.withoutValue(command);
				return index;
			}
			const argument = args[index]!;
			apply(command, optionValue(args, index, argument), argument);
			return index + 1;
		},
	};
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

const config = value(
	"--config",
	"path",
	"Use an explicit build configuration",
	(command: { configPath?: string }, configPath) => (command.configPath = configPath),
	{ default: "maligator.build.ts if present" },
);

const profile = flag(
	"--profile",
	"Sample production code. Compiler mode adds counters",
	(command: { profile: boolean; profileCompiler?: boolean }, argument) => {
		command.profile = true;
		if (argument === "--profile=compiler") command.profileCompiler = true;
	},
	{ alias: "--profile=compiler", label: "--profile[=compiler]" },
);

type DoctorCommand = Extract<CliCommand, { kind: "doctor" }>;
type CacheOptions = CacheCommand & { all?: true };
type RunOptions = Omit<DevCommand, "kind">;
interface FfiOptions {
	configPath?: string;
	target?: string;
	json: boolean;
	update: boolean;
	outPath?: string;
	probePath?: string;
	probeTimeoutMs?: number;
}

const TEST_DEFAULTS = {
	repeat: 1,
	timeoutMs: 5000,
	compileConcurrency: 1,
	executionConcurrency: 1,
};
const FFI_PROBE_TIMEOUT_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const ffiTarget = value(
	"--target",
	"rust-triple",
	"Read headers for a cross-build target through Zig",
	(command: FfiOptions, target) => (command.target = target),
);

const ffiJson = flag(
	"--json",
	"Print the report as JSON",
	(command: FfiOptions) => (command.json = true),
);

const runOptions: ReadonlyArray<CliOption<RunOptions>> = [
	config,
	profile,
	flag("--verbose", "Show compiler diagnostics", (command) => (command.verbose = true)),
];

function describeCommand<Command>(
	usage: string,
	description: string,
	options: ReadonlyArray<CliOption<Command>>,
) {
	return { usage, description, options };
}

const COMMAND_HELP = {
	init: { usage: "init", description: "Create maligator.build.ts." },
	doctor: describeCommand<DoctorCommand>(
		"doctor [options]",
		"Check the native build toolchain.",
		[
			flag("--verbose", "Show versions, paths and probe details", (command) => {
				command.verbose = true;
			}),
			value(
				"--target",
				"rust-triple",
				"Check a cross-build target",
				(command, target) => {
					command.target = target;
				},
			),
		],
	),
	cache: {
		usage: "cache <command>",
		description: "Inspect or clear the Maligator cache.",
		subcommands: ["cache status", "cache prune", "cache clear"] as const,
	},
	"cache status": describeCommand<CacheOptions>(
		"cache status",
		"Show cache usage, budget and last maintenance.",
		[],
	),
	"cache prune": describeCommand<CacheOptions>(
		"cache prune [options]",
		"Remove stale rebuildable cache entries.",
		[
			value(
				"--max-gb",
				"number",
				"Set the target cache size in GiB",
				(command, size, argument) =>
					(command.maxBytes = positiveNumber(size, argument) * 1024 ** 3),
				{ default: "cache budget's trim size" },
			),
			value(
				"--min-age-days",
				"number",
				"Set the minimum age of entries eligible for removal",
				(command, days, argument) =>
					(command.minAgeMs = positiveNumber(days, argument) * DAY_MS),
				{ default: 1 },
			),
			flag("--dry-run", "Show which entries would be removed", (command) => {
				command.dryRun = true;
			}),
			flag("--verbose", "Show each entry selected for removal", (command) => {
				command.verbose = true;
			}),
		],
	),
	"cache clear": describeCommand<CacheOptions>(
		"cache clear --all",
		"Remove every rebuildable cache entry.",
		[
			flag("--all", "Confirm removal of all rebuildable entries", (command) => {
				command.all = true;
			}),
		],
	),
	"cache maintain": describeCommand<CacheOptions>(
		"cache maintain",
		"Trim the cache if it exceeds its budget.",
		[],
	),
	ffi: {
		usage: "ffi <command>",
		description: "Inspect C bindings, generate declarations or check accepted facts.",
		subcommands: ["ffi inspect", "ffi types", "ffi check"] as const,
	},
	"ffi inspect": describeCommand<FfiOptions>(
		"ffi inspect <library> [options]",
		"Show a C library's bindings and the facts they need.",
		[config, ffiTarget, ffiJson],
	),
	"ffi types": describeCommand<FfiOptions>(
		"ffi types [options]",
		"Write TypeScript declarations for configured C libraries.",
		[
			config,
			ffiTarget,
			value(
				"--out",
				"path",
				"Write declarations to this file",
				(command, outPath) => (command.outPath = outPath),
				{ default: "maligator-ffi.d.ts" },
			),
		],
	),
	"ffi check": describeCommand<FfiOptions>(
		"ffi check [library] [options]",
		"Check accepted C declarations and facts.",
		[
			config,
			ffiTarget,
			ffiJson,
			value(
				"--out",
				"path",
				"Read or update this snapshot",
				(command, outPath) => (command.outPath = outPath),
				{ default: "maligator-ffi.lock.json" },
			),
			flag("--update", "Accept current declarations and facts", (command) => {
				command.update = true;
			}),
			value(
				"--probe",
				"path",
				"Run selected native sanitizer tests",
				(command, probePath) => {
					command.probePath = probePath;
				},
			),
			value(
				"--probe-timeout",
				"ms",
				"Set the probe deadline in milliseconds (requires --probe)",
				(command, timeout, argument) =>
					(command.probeTimeoutMs = positiveInteger(timeout, argument)),
				{ default: FFI_PROBE_TIMEOUT_MS },
			),
		],
	),
	build: describeCommand<BuildCommand>(
		"build [entry] [options]",
		"Compile an application to a native executable.",
		[
			config,
			value("--name", "name", "Override the executable name", (command, name) => {
				command.internal.name = name;
			}),
			value(
				"--target",
				"rust-triple",
				"Cross-build for this Rust target",
				(command, target) => {
					command.target = target;
				},
			),
			flag("--production", "Build with production optimizations", (command) => {
				command.production = true;
			}),
			value(
				"--compile-concurrency",
				"count",
				"Limit production build jobs to 1 through 3",
				(command, count) => {
					const parsed = Number(count);
					if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 3) {
						throw new CliUsageError(
							"build --compile-concurrency requires an integer from 1 through 3",
						);
					}
					command.compileConcurrency = parsed;
				},
				{ default: "up to 3 based on CPU capacity" },
			),
			value(
				"--artifact",
				"directory",
				"Write a deployable production artifact",
				(command, directory) => {
					command.artifactDirectory = directory;
				},
			),
			profile,
			flag("--verbose", "Show compiler diagnostics", (command) => {
				command.internal.verbose = true;
			}),
			value(
				"--core-report",
				"mode",
				"Show phases, counters, or full Core diagnostics",
				(command, mode) => {
					if (mode !== "phases" && mode !== "counters" && mode !== "full") {
						throw new CliUsageError("--core-report requires phases, counters, or full");
					}
					command.internal.coreReport = mode;
					command.internal.verbose = true;
				},
			),
			value("--serialize", "file", "Write a portable program image", (command, file) => {
				command.internal.serializePath = file;
			}),
			flag(
				"--render-native-c",
				"Print generated C",
				(command) => {
					command.internal.emitC = true;
				},
				{ alias: "--print" },
			),
			flag("--no-compiled", "Use the interpreted native backend", (command) => {
				command.internal.compiled = false;
			}),
			flag("--dump-core", "Print the Core program", (command) => {
				command.internal.dumpCore = true;
			}),
		],
	),
	run: describeCommand<RunOptions>(
		"run [entry] [options] [-- args...]",
		"Compile and run an application.",
		runOptions,
	),
	dev: describeCommand<RunOptions>(
		"dev [entry] [options] [-- args...]",
		"Watch, rebuild, and restart an application.",
		[
			...runOptions,
			flag("--status", "Stream generation and resource states", (command) => {
				command.status = true;
			}),
		],
	),
	test: describeCommand<TestCommand>(
		"test [path ...] [options]",
		"Discover and run test files.",
		[
			config,
			value("--run", "name", "Filter tests by hierarchical name", (command, name) => {
				command.nameFilter = name;
			}),
			value(
				"--shuffle",
				"seed",
				"Shuffle tests and print the chosen or supplied seed",
				(command, seed, argument) => (command.shuffle = positiveInteger(seed, argument)),
				{ withoutValue: (command) => (command.shuffle = true) },
			),
			value(
				"--repeat",
				"count",
				"Repeat selected tests without recompiling",
				(command, count, argument) => (command.repeat = positiveInteger(count, argument)),
				{ default: TEST_DEFAULTS.repeat },
			),
			value(
				"--timeout",
				"ms",
				"Set the callback deadline in milliseconds",
				(command, timeout, argument) =>
					(command.timeoutMs = positiveInteger(timeout, argument)),
				{ default: TEST_DEFAULTS.timeoutMs },
			),
			value(
				"--compile-concurrency",
				"count",
				"Bound test compilation jobs",
				(command, count, argument) =>
					(command.compileConcurrency = positiveInteger(count, argument)),
				{ default: TEST_DEFAULTS.compileConcurrency },
			),
			flag(
				"--isolate",
				"Run each selected test file in a fresh application",
				(command) => {
					command.isolation = "file";
				},
			),
			value(
				"--concurrency",
				"count",
				"Bound isolated test executions (requires --isolate above 1)",
				(command, count, argument) =>
					(command.executionConcurrency = positiveInteger(count, argument)),
				{ default: TEST_DEFAULTS.executionConcurrency },
			),
			flag(
				"--watch",
				"Retain test images and rerun on SIGHUP on POSIX hosts",
				(command) => {
					command.watch = true;
				},
			),
			flag(
				"--watch-failed",
				"Rerun failed files on unchanged SIGHUP reruns (requires --watch)",
				(command) => {
					command.watchFailed = true;
				},
			),
			flag(
				"--status",
				"Stream generation and resource states (requires --watch)",
				(command) => {
					command.status = true;
				},
			),
			flag("--bail", "Stop after the first failure", (command) => {
				command.bail = true;
			}),
			profile,
			flag("--verbose", "Show compiler diagnostics (requires --profile)", (command) => {
				command.verbose = true;
			}),
		],
	),
};

type HelpCommand = keyof typeof COMMAND_HELP;
const MAIN_COMMANDS = [
	"init",
	"doctor",
	"cache",
	"ffi",
	"build",
	"run",
	"dev",
	"test",
] as const;

function helpRows(rows: ReadonlyArray<HelpRow>): string {
	const width = Math.max(...rows.map(({ label }) => label.length));
	return rows
		.map(
			({ label, description, default: fallback }) =>
				`  ${label.padEnd(width)}  ${description}${fallback === undefined ? "" : ` (default: ${fallback})`}`,
		)
		.join("\n");
}

function commandRows(commands: ReadonlyArray<HelpCommand>): string {
	return helpRows(
		commands.map((name) => ({
			label: COMMAND_HELP[name].usage,
			description: COMMAND_HELP[name].description,
		})),
	);
}

export function formatCliHelp(command?: HelpCommand): string {
	if (command === undefined) {
		return [
			"Usage: maligator <command> [options]",
			`Commands:\n${commandRows(MAIN_COMMANDS)}`,
			`Options:\n${helpRows([HELP_OPTION, VERSION_OPTION])}`,
			"Run 'maligator <command> --help' for command options.",
		].join("\n\n");
	}
	const help = COMMAND_HELP[command];
	const sections = [`Usage: maligator ${help.usage}`, help.description];
	if ("subcommands" in help) {
		sections.push(`Commands:\n${commandRows(help.subcommands)}`);
	}
	sections.push(
		`Options:\n${helpRows("options" in help ? [...help.options, HELP_OPTION] : [HELP_OPTION])}`,
	);
	return sections.join("\n\n");
}

function readOption<Command>(
	options: ReadonlyArray<CliOption<Command>>,
	command: Command,
	args: Array<string>,
	index: number,
): number | "help" | undefined {
	const argument = args[index]!;
	if (HELP_OPTION.names.includes(argument)) return "help";
	return options
		.find((option) => option.names.includes(argument))
		?.read(command, args, index);
}

function unexpectedArgument(command: string, argument: string): never {
	if (argument.startsWith("-")) {
		throw new CliUsageError(`unknown option '${argument}' for '${command}'`);
	}
	throw new CliUsageError(`unexpected argument '${argument}' for '${command}'`);
}

function parseInit(args: Array<string>): CliCommand {
	if (args.length === 1) return { kind: "init" };
	if (args.length === 2 && HELP_OPTION.names.includes(args[1]!)) {
		return { kind: "help", command: "init" };
	}
	return unexpectedArgument("init", args[1]!);
}

function parseDoctor(args: Array<string>): CliCommand {
	const command: DoctorCommand = { kind: "doctor", verbose: false };
	for (let index = 1; index < args.length; index++) {
		const next = readOption(COMMAND_HELP.doctor.options, command, args, index);
		if (next === "help") return { kind: "help", command: "doctor" };
		if (next === undefined) return unexpectedArgument("doctor", args[index]!);
		index = next;
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
		const next = readOption(COMMAND_HELP.build.options, command, args, index);
		if (next === "help") return { kind: "help", command: "build" };
		if (next !== undefined) {
			index = next;
			continue;
		}
		if (argument === "--") {
			const trailing = args[index + 1];
			throw new CliUsageError(
				trailing === undefined
					? "'--' is only valid for 'maligator run' or 'maligator dev'"
					: `unexpected argument '${trailing}' for 'build'`,
			);
		}
		if (argument === "--run") {
			throw new CliUsageError("unknown option '--run' for 'build'; use 'maligator run'");
		}
		if (argument.startsWith("-") || command.entry !== undefined) {
			return unexpectedArgument("build", argument);
		}
		command.entry = argument;
	}

	if (command.compileConcurrency !== undefined && !command.production)
		throw new CliUsageError("build --compile-concurrency requires --production");
	if ((command.compileConcurrency ?? 1) > 1 && (!command.production || command.profile))
		throw new CliUsageError(
			"parallel build compilation requires --production without --profile",
		);
	return command;
}

function parseRun(args: Array<string>, kind: "run" | "dev"): CliCommand {
	const command: RunCommand | DevCommand = {
		kind,
		verbose: false,
		profile: false,
		programArgs: [],
	};
	const options = COMMAND_HELP[kind].options;

	for (let index = 1; index < args.length; index++) {
		const argument = args[index]!;
		if (argument === "--") {
			command.programArgs = args.slice(index + 1);
			return command;
		}
		const next = readOption(options, command, args, index);
		if (next === "help") return { kind: "help", command: kind };
		if (next !== undefined) {
			index = next;
			continue;
		}
		if (argument.startsWith("-") || command.entry !== undefined) {
			return unexpectedArgument(kind, argument);
		}
		command.entry = argument;
	}

	return command;
}

function parseCache(args: Array<string>): CliCommand {
	const action = args[1];
	if (action !== undefined && HELP_OPTION.names.includes(action)) {
		return { kind: "help", command: "cache" };
	}
	if (
		action !== "status" &&
		action !== "prune" &&
		action !== "clear" &&
		action !== "maintain"
	) {
		throw new CliUsageError("cache requires 'status', 'prune', or 'clear'");
	}
	const topic = `cache ${action}` as const;
	const command: CacheOptions = { kind: "cache", action, dryRun: false, verbose: false };
	for (let index = 2; index < args.length; index++) {
		const next = readOption(COMMAND_HELP[topic].options, command, args, index);
		if (next === "help") return { kind: "help", command: topic };
		if (next === undefined) return unexpectedArgument(topic, args[index]!);
		index = next;
	}
	const { all, ...cacheCommand } = command;
	if (action === "clear" && all !== true) {
		throw new CliUsageError("cache clear requires '--all'");
	}
	return cacheCommand;
}

function parseFfi(args: Array<string>): CliCommand {
	const action = args[1];
	if (action !== undefined && HELP_OPTION.names.includes(action)) {
		return { kind: "help", command: "ffi" };
	}
	if (action !== "inspect" && action !== "types" && action !== "check") {
		throw new CliUsageError("ffi requires 'inspect', 'types', or 'check'");
	}
	const topic = `ffi ${action}` as const;
	const options: FfiOptions = { json: false, update: false };
	let library: string | undefined;
	for (let index = 2; index < args.length; index++) {
		const argument = args[index]!;
		const next = readOption(COMMAND_HELP[topic].options, options, args, index);
		if (next === "help") return { kind: "help", command: topic };
		if (next !== undefined) {
			index = next;
			continue;
		}
		if (action !== "types" && library === undefined && !argument.startsWith("-")) {
			library = argument;
			continue;
		}
		return unexpectedArgument(topic, argument);
	}
	const { configPath, target, json, update, outPath, probePath, probeTimeoutMs } =
		options;
	const shared = {
		kind: "ffi" as const,
		...(configPath === undefined ? {} : { configPath }),
		...(target === undefined ? {} : { target }),
	};
	if (action === "types") {
		return { ...shared, action, ...(outPath === undefined ? {} : { outPath }) };
	}
	if (action === "check") {
		if (probePath === undefined && probeTimeoutMs !== undefined)
			throw new CliUsageError("--probe-timeout requires --probe");
		if (probePath !== undefined && target !== undefined)
			throw new CliUsageError(
				"FFI probes run on the host; omit --target when using --probe",
			);
		return {
			...shared,
			action,
			json,
			update,
			...(probePath === undefined
				? {}
				: {
						probe: { path: probePath, timeoutMs: probeTimeoutMs ?? FFI_PROBE_TIMEOUT_MS },
					}),
			...(library === undefined ? {} : { library }),
			...(outPath === undefined ? {} : { outPath }),
		};
	}
	if (library === undefined)
		throw new CliUsageError("ffi inspect requires a library name");
	return { ...shared, action, library, json };
}

function parseTest(args: Array<string>): CliCommand {
	const command: TestCommand = {
		kind: "test",
		paths: [],
		repeat: TEST_DEFAULTS.repeat,
		bail: false,
		timeoutMs: TEST_DEFAULTS.timeoutMs,
		compileConcurrency: TEST_DEFAULTS.compileConcurrency,
		profile: false,
	};
	for (let index = 1; index < args.length; index++) {
		const argument = args[index]!;
		const next = readOption(COMMAND_HELP.test.options, command, args, index);
		if (next === "help") return { kind: "help", command: "test" };
		if (next !== undefined) {
			index = next;
			continue;
		}
		if (argument.startsWith("-")) return unexpectedArgument("test", argument);
		command.paths.push(argument);
	}
	if (
		(command.executionConcurrency ?? TEST_DEFAULTS.executionConcurrency) > 1 &&
		command.isolation === undefined
	) {
		throw new CliUsageError("--concurrency greater than 1 requires --isolate");
	}
	if (command.isolation !== undefined && command.profile) {
		throw new CliUsageError("--isolate cannot be combined with --profile");
	}
	if (command.watch && command.profile)
		throw new CliUsageError("--watch cannot be combined with --profile");
	if (command.verbose && !command.profile)
		throw new CliUsageError("test --verbose requires --profile");
	if (command.watchFailed && !command.watch)
		throw new CliUsageError("--watch-failed requires --watch");
	if (command.status && !command.watch)
		throw new CliUsageError("test --status requires --watch");
	return command;
}

export function parseCliArgs(args: Array<string>): CliCommand {
	const command = args[0];
	if (command === undefined) {
		throw new CliUsageError("missing command");
	}
	if (command === "help" || HELP_OPTION.names.includes(command)) {
		if (args.length > 1) {
			return unexpectedArgument("help", args[1]!);
		}
		return { kind: "help" };
	}
	if (VERSION_OPTION.names.includes(command)) {
		if (args.length > 1) {
			return unexpectedArgument("version", args[1]!);
		}
		return { kind: "version" };
	}
	if (command === "init") return parseInit(args);
	if (command === "doctor") return parseDoctor(args);
	if (command === "build") return parseBuild(args);
	if (command === "run" || command === "dev") return parseRun(args, command);
	if (command === "test") return parseTest(args);
	if (command === "cache") return parseCache(args);
	if (command === "ffi") return parseFfi(args);

	const suggestion = command.startsWith("-")
		? `unknown option '${command}'`
		: `unknown command '${command}'`;
	throw new CliUsageError(
		`${suggestion}; expected init, doctor, cache, ffi, build, run, dev, or test`,
	);
}
