import { existsSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { includeConfiguredAssets } from "./assets.ts";
import { createBuildArtifact } from "./build-artifact.ts";
import {
	BuildConfigError,
	buildDerivationFromConfig,
	loadBuildConfig,
	resolveOutputName,
} from "./build-config.ts";
import type { BuildConfigTypeStripper, ResolvedBuildConfig } from "./build-config.ts";
import { gmallocEnabled, runEnv, selectNativeBuildPlan } from "./build-flags.ts";
import type { NativeBuildPlan } from "./build-flags.ts";
import { compileBuildFrontend } from "./build-frontend-cache.ts";
import { initProject, InitError } from "./cli-init.ts";
import { executeBinary } from "./cli-run.ts";
import { CLI_HELP, CliUsageError, MALIGATOR_VERSION, parseCliArgs } from "./cli.ts";
import type { BuildCommand, RunCommand, TestCommand } from "./cli.ts";
import { compileEntrypointToBuffer } from "./compile-program.ts";
import { emitVmTranslationUnits } from "./emit-vm.ts";
import { dumpProgramEscape, dumpStackAlloc } from "./escape.ts";
import {
	debugHofInlineSites,
	debugInlinableCalls,
	debugMethodInlineSites,
	debugSpeculativeInlineSites,
} from "./inline.ts";
import { debugProgramLiveness } from "./liveness.ts";
import { buildLocalBinary } from "./local-build.ts";
import { vmDefinitionStats } from "./lower-vm.ts";
import { resolveNativeBuildContext } from "./native-build-context.ts";
import { executeTestCommand } from "./testing/command.ts";
import {
	formatToolchainReport,
	formatToolCommand,
	inspectToolchain,
	requireToolchain,
	ToolchainError,
} from "./toolchain.ts";
import type { Toolchain } from "./toolchain.ts";
import { debugEnabled, log } from "./utils.ts";

export interface CommandContext {
	stripTypes: BuildConfigTypeStripper;
	installation: CompilerInstallation;
}

export interface CompilerInstallation {
	/** Absolute runtime source tree owned by this compiler installation. */
	runtimeDirectory: string;
	/** License notice copied into deployable artifacts. */
	licensePath?: string;
	/** Source implementation supplied for the virtual maligator:test module. */
	testModulePath: string;
	/** Cache identity of the active TypeScript erasure frontend. */
	frontendIdentity: string;
	evalCompiler:
		| { kind: "source"; sourceDirectory: string; entrypoint: string }
		| { kind: "prebuilt"; wirePath: string };
}

export function developmentCompilerInstallation(
	moduleDirectory: string,
): CompilerInstallation {
	const sourceDirectory = path.resolve(moduleDirectory);
	return {
		runtimeDirectory: path.resolve(sourceDirectory, "../runtime"),
		licensePath: path.resolve(sourceDirectory, "../LICENSE"),
		testModulePath: path.join(sourceDirectory, "testing/runtime.mjs"),
		frontendIdentity: "typescript-strip-v1",
		evalCompiler: {
			kind: "source",
			sourceDirectory,
			entrypoint: path.join(sourceDirectory, "eval-compiler-entry.mts"),
		},
	};
}

export function productCompilerInstallation(
	runtimeDirectory: string,
	compilerWirePath: string,
	testModulePath: string,
	licensePath?: string,
): CompilerInstallation {
	return {
		runtimeDirectory: path.resolve(runtimeDirectory),
		...(licensePath === undefined ? {} : { licensePath: path.resolve(licensePath) }),
		testModulePath: path.resolve(testModulePath),
		frontendIdentity: "compact-type-strip-v1",
		evalCompiler: { kind: "prebuilt", wirePath: path.resolve(compilerWirePath) },
	};
}

export interface BuildCommandResult {
	binaryPath?: string;
	serializedPath?: string;
	artifactDirectory?: string;
}

class CommandError extends Error {
	exitCode: number;

	constructor(message: string, exitCode = 1) {
		super(message);
		this.name = "CommandError";
		this.exitCode = exitCode;
	}
}

function commandError(message: string, exitCode = 1): never {
	throw new CommandError(message, exitCode);
}

function loadCommandConfig(
	command: BuildCommand | RunCommand | TestCommand,
	stripTypes: BuildConfigTypeStripper,
): ResolvedBuildConfig {
	try {
		return loadBuildConfig(command.configPath, process.cwd(), stripTypes);
	} catch (error) {
		if (error instanceof BuildConfigError) commandError(`error: ${error.message}`);
		throw error;
	}
}

function resolveEntrypoint(
	command: BuildCommand | RunCommand,
	config: ResolvedBuildConfig,
): string {
	const entrypoint = command.entry ?? config.entry;
	if (entrypoint === undefined) {
		commandError(
			"error: no entrypoint was provided and the build config has no 'entry'; " +
				"pass an entry or run 'maligator init'",
		);
	}
	if (!existsSync(entrypoint)) {
		commandError(`error: entrypoint does not exist: ${path.resolve(entrypoint)}`);
	}
	return path.resolve(entrypoint);
}

function selectToolchain(
	command: BuildCommand | RunCommand,
	config: ResolvedBuildConfig,
	context: CommandContext,
): { toolchain?: Toolchain; plan?: NativeBuildPlan } {
	if (command.kind === "build" && command.internal.serializePath !== undefined) return {};
	try {
		const toolchain = requireToolchain({
			needsCxx: config.surface.webPlatform,
			rustDir: path.join(context.installation.runtimeDirectory, "rust"),
			target: command.kind === "build" ? command.target : undefined,
		});
		const plan = selectNativeBuildPlan(
			toolchain,
			command.kind === "build" && command.production,
		);
		log.info(`Toolchain: ${formatToolCommand(toolchain.tools.cc)} (${toolchain.target})`);
		log.info(`Toolchain cache: ${toolchain.cacheHit ? "hit" : "miss"}`);
		for (const warning of plan.warnings) log.info(`warning: ${warning}`);
		return { toolchain, plan };
	} catch (error) {
		if (error instanceof ToolchainError) commandError(error.message);
		throw error;
	}
}

export function applicationDriverPath(
	installation: CompilerInstallation,
	webPlatform: boolean,
	node = false,
): string {
	return path.join(
		installation.runtimeDirectory,
		webPlatform || node ? "host_main.c" : "test262_main.c",
	);
}

function compileAndBuild(
	command: BuildCommand | RunCommand,
	context: CommandContext,
): BuildCommandResult {
	const buildConfig = loadCommandConfig(command, context.stripTypes);
	const entrypointPath = resolveEntrypoint(command, buildConfig);
	if (
		command.kind === "build" &&
		command.internal.serializePath !== undefined &&
		Object.keys(buildConfig.assets).length > 0
	) {
		commandError("error: configured assets are not supported by portable wire output");
	}
	if (
		command.kind === "build" &&
		command.internal.serializePath !== undefined &&
		command.target !== undefined
	) {
		commandError("error: '--target' is not applicable to portable wire output");
	}
	if (
		command.kind === "build" &&
		command.internal.serializePath !== undefined &&
		command.artifactDirectory !== undefined
	) {
		commandError("error: '--artifact' is not applicable to portable wire output");
	}
	if (
		command.kind === "build" &&
		command.artifactDirectory !== undefined &&
		!command.production
	) {
		commandError("error: '--artifact' requires '--production'");
	}
	let assets: ReturnType<typeof includeConfiguredAssets>;
	try {
		assets = includeConfiguredAssets(buildConfig.assets);
	} catch (error) {
		if (error instanceof BuildConfigError) commandError(`error: ${error.message}`);
		throw error;
	}
	const { toolchain, plan } = selectToolchain(command, buildConfig, context);

	const compilerDiagnostics =
		command.kind === "build" &&
		(command.internal.dumpLiveness ||
			command.internal.dumpInline ||
			command.internal.dumpHof ||
			command.internal.dumpSpeculative ||
			command.internal.dumpMethods ||
			command.internal.dumpEscape ||
			command.internal.dumpStackAlloc);
	let frontend: ReturnType<typeof compileBuildFrontend>;
	try {
		frontend = compileBuildFrontend({
			entrypoint: entrypointPath,
			config: buildConfig,
			stripTypes: context.stripTypes,
			stripperIdentity: context.installation.frontendIdentity,
			enforcePolicies: !(
				command.kind === "build" && command.internal.serializePath !== undefined
			),
			forceCompile: debugEnabled || compilerDiagnostics,
			afterOptimization: (irProgram) => {
				if (command.kind === "build" && command.internal.dumpLiveness) {
					log.info(debugProgramLiveness(irProgram));
				}
				if (command.kind === "build" && command.internal.dumpInline) {
					debugInlinableCalls(irProgram);
				}
				if (command.kind === "build" && command.internal.dumpHof) {
					debugHofInlineSites(irProgram);
				}
				if (command.kind === "build" && command.internal.dumpSpeculative) {
					debugSpeculativeInlineSites(irProgram);
				}
				if (command.kind === "build" && command.internal.dumpMethods) {
					debugMethodInlineSites(irProgram);
				}
				if (command.kind === "build" && command.internal.dumpEscape) {
					dumpProgramEscape(irProgram);
				}
				if (command.kind === "build" && command.internal.dumpStackAlloc) {
					dumpStackAlloc(irProgram);
				}
			},
		});
	} catch (error) {
		if (error instanceof BuildConfigError) commandError(`error: ${error.message}`);
		throw error;
	}
	const vmDefinition = frontend.definition;
	log.info(`Cache frontend: ${frontend.cache} (${frontend.frontendMs}ms)`);
	log.debug(
		`Frontend: validation ${frontend.phases.validationMs}ms, graph ${frontend.phases.graphMs}ms, ` +
			`semantic ${frontend.phases.semanticMs}ms, compile ${frontend.phases.compileMs}ms, ` +
			`serialize ${frontend.phases.serializeMs}ms`,
	);

	const stats = vmDefinitionStats(vmDefinition);
	log.info(`Functions: ${stats.functionCount}, instructions: ${stats.instructionCount}`);

	const serializePath =
		command.kind === "build" ? command.internal.serializePath : undefined;
	if (serializePath !== undefined) {
		writeFileSync(serializePath, frontend.wire);
		log.info(`Serialized: ${serializePath} (${frontend.wire.length} bytes)`);
		return { serializedPath: serializePath };
	}

	const output = emitVmTranslationUnits(vmDefinition, {
		compiled: command.kind === "run" || command.internal.compiled,
		assets,
		maligatorSurface: buildConfig.surface.maligator,
	});
	if (command.kind === "build" && command.internal.emitC) log.info(output.join("\n"));

	const name =
		command.kind === "build"
			? (command.internal.name ?? resolveOutputName(buildConfig))
			: resolveOutputName(buildConfig);
	const verbose = command.kind === "build" && command.internal.verbose;
	const buildTiming = log.time("build binary");
	const evalCompiler = context.installation.evalCompiler;
	const compilerBake =
		evalCompiler.kind === "source"
			? {
					kind: "source" as const,
					sourceDirectory: evalCompiler.sourceDirectory,
					entrypoint: evalCompiler.entrypoint,
					bake: () =>
						compileEntrypointToBuffer(evalCompiler.entrypoint, {
							stripTypes: context.stripTypes,
						}),
				}
			: { kind: "prebuilt" as const, path: evalCompiler.wirePath };
	const derivation = buildDerivationFromConfig(buildConfig);
	const nativeContext = resolveNativeBuildContext({
		toolchain,
		plan,
		runtimeDirectory: context.installation.runtimeDirectory,
		features: derivation.features,
		compilerBake,
		onCacheEvent: (event) =>
			log.info(`Cache ${event.artifact}: ${event.hit ? "hit" : "miss"} (${event.path})`),
	});
	const { binaryPath } = buildLocalBinary({
		context: nativeContext,
		name,
		cSource: output,
		verbose,
		onWarning: (warning) => log.info(`warning: ${warning}`),
		onGeneratedObjectCacheEvent: (event) =>
			log.info(`Cache generated C: ${event.hit ? "hit" : "miss"} (${event.path})`),
		mainFile: applicationDriverPath(
			context.installation,
			buildConfig.surface.webPlatform,
			buildConfig.surface.node,
		),
		cacheSuffix: derivation.cacheSuffix,
	});
	buildTiming();
	log.info(`Binary: ${binaryPath}`);
	if (command.kind === "build" && command.artifactDirectory !== undefined) {
		let artifact: ReturnType<typeof createBuildArtifact>;
		try {
			artifact = createBuildArtifact({
				binaryPath,
				directory: command.artifactDirectory,
				licensePath: context.installation.licensePath,
				version: MALIGATOR_VERSION,
				target: nativeContext.toolchain.rustTarget,
				production: true,
			});
		} catch (error) {
			commandError(
				`error: could not create artifact: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		log.info(`Artifact: ${artifact.directory}`);
		return { binaryPath, artifactDirectory: artifact.directory };
	}
	return { binaryPath };
}

/** Compile and link one parsed `build` command without owning process dispatch. */
export function buildCommand(
	command: BuildCommand,
	context: CommandContext,
): BuildCommandResult {
	return compileAndBuild(command, context);
}

/** Compile, link, and execute one parsed `run` command. */
export function runCommand(command: RunCommand, context: CommandContext): void {
	const result = compileAndBuild(command, context);
	const binaryPath = result.binaryPath!;
	if (gmallocEnabled()) log.info("Running under Guard Malloc (MAL_GMALLOC).");
	const outcome = executeBinary(binaryPath, command.programArgs, runEnv());
	if (outcome.status === 0) {
		log.info("Exit: 0");
		return;
	}
	log.info(
		`Exit: ${outcome.signal ? `signal ${outcome.signal}` : (outcome.status ?? "error")}`,
	);
	if (outcome.signal !== undefined) process.kill(process.pid, outcome.signal);
	process.exit(outcome.status ?? 1);
}

/** Product command dispatcher shared by the Node CLI and the compiled bootstrap. */
export async function runCli(
	args: Array<string>,
	context: CommandContext,
): Promise<void> {
	try {
		const command = parseCliArgs(args);
		if (command.kind === "help") {
			log.info(CLI_HELP);
			return;
		}
		if (command.kind === "version") {
			log.info(MALIGATOR_VERSION);
			return;
		}
		if (command.kind === "init") {
			try {
				log.info(`Created ${initProject()}`);
				return;
			} catch (error) {
				if (error instanceof InitError) commandError(`error: ${error.message}`);
				throw error;
			}
		}
		if (command.kind === "doctor") {
			const report = inspectToolchain({
				rustDir: path.join(context.installation.runtimeDirectory, "rust"),
				target: command.target,
			});
			log.info(
				formatToolchainReport(
					report,
					report.platform ?? process.platform,
					command.verbose,
				),
			);
			if (report.toolchain === undefined) process.exit(1);
			return;
		}
		if (command.kind === "build") {
			buildCommand(command, context);
		} else if (command.kind === "run") {
			runCommand(command, context);
		} else {
			let result: Awaited<ReturnType<typeof executeTestCommand>>;
			try {
				result = await executeTestCommand(
					command,
					context,
					loadCommandConfig(command, context.stripTypes),
				);
			} catch (error) {
				commandError(`error: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (result.exitCode !== 0) process.exit(result.exitCode);
		}
	} catch (error) {
		if (error instanceof CliUsageError) {
			// eslint-disable-next-line no-console -- usage failures belong on stderr.
			console.error(`error: ${error.message}`);
			// eslint-disable-next-line no-console -- usage failures belong on stderr.
			console.error("Run 'maligator --help' for usage.");
			process.exit(2);
		}
		if (error instanceof CommandError) {
			log.info(error.message);
			process.exit(error.exitCode);
		}
		throw error;
	}
}
