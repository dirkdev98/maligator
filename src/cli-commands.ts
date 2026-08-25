import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
import {
	gmallocEnabled,
	normalizeNativeFeatures,
	runEnv,
	selectNativeBuildPlan,
} from "./build-flags.ts";
import type { NativeBuildPlan } from "./build-flags.ts";
import { validateBuildFragmentRequest } from "./build-fragment-cache.ts";
import { compileBuildFrontend } from "./build-frontend-cache.ts";
import { BuildReporter } from "./build-progress.ts";
import {
	clearAllMaligatorCaches,
	createCacheLease,
	DEFAULT_CACHE_MAX_BYTES,
	DEFAULT_CACHE_MIN_AGE_MS,
	formatCacheBytes,
	inspectMaligatorCache,
	maybeMaintainMaligatorCache,
	pruneMaligatorCache,
} from "./cache-management.ts";
import { maligatorCacheDirectory, MaligatorCacheRootError } from "./cache-root.ts";
import { BUILD_CONFIG_NAME, initProject, InitError } from "./cli-init.ts";
import { executeBinary, executeBinaryCaptured } from "./cli-run.ts";
import { CLI_HELP, CliUsageError, MALIGATOR_VERSION, parseCliArgs } from "./cli.ts";
import type {
	BuildCommand,
	CacheCommand,
	DevCommand,
	RunCommand,
	TestCommand,
} from "./cli.ts";
import { CommandProgress, formatCommandDuration } from "./command-progress.ts";
import { compilerEntrypointSourceFiles } from "./compiler-bake.ts";
import { formatCoreFunction } from "./compiler/core/core-ir.ts";
import { TYPE_STRIPPER_IDENTITY } from "./compiler/frontend/compact-type-strip.ts";
import { compileEntrypointToBuffer } from "./compiler/pipeline/compile-program.ts";
import { emitProgramTranslationUnits } from "./compiler/target/emit-program-image.ts";
import { compileDependencyFragmentRequest } from "./dependency-fragment-cache.ts";
import type { DependencyFragmentWorker } from "./dependency-fragment-cache.ts";
import { cacheDevelopmentAssets } from "./development-assets.ts";
import { cacheFrontendWire, FrontendCompilationSession } from "./frontend-cache.ts";
import { buildDevelopmentRunner, buildLocalBinary } from "./local-build.ts";
import { resolveNativeBuildContext } from "./native-build-context.ts";
import { nativeBuildJobs } from "./native-command.ts";
import {
	createProfileCapture,
	finalizeProfileCapture,
	formatProfileReport,
	prepareProfile,
} from "./profile-artifact.ts";
import type { PreparedProfile } from "./profile-artifact.ts";
import {
	executeTestCommand,
	ISOLATED_TEST_RESULT_PREFIX,
	prepareIsolatedTestCommand,
	prepareProfiledTestCommand,
	reportIsolatedTestResult,
	reportProfiledTestResult,
} from "./testing/command.ts";
import type { TestCommandSummary } from "./testing/command.ts";
import type { TestRunResult } from "./testing/protocol.ts";
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
	developmentProcesses?: DevelopmentProcessHost;
	developmentWatcher?: DevelopmentWatchHost;
	frontendSession?: FrontendCompilationSession;
	developmentCache?: DevelopmentBuildCache;
	dependencyWorker?: DependencyFragmentWorker;
}

export interface DevelopmentWatchHost {
	create(files: Array<string>): unknown;
	update(handle: unknown, files: Array<string>): void;
	wait(handle: unknown, timeoutMs: number): Promise<void>;
	close(handle: unknown): void;
}

interface DevelopmentBuildCache {
	toolchains: Map<string, { toolchain: Toolchain; plan: NativeBuildPlan }>;
	runners: Map<string, string>;
}

export interface DevelopmentProcessHost {
	spawn(
		executablePath: string,
		args: Array<string>,
		environment?: NodeJS.ProcessEnv,
	): unknown;
	kill(handle: unknown, force?: boolean): void;
	/** Undefined while running, otherwise the conventional process exit code. */
	status(handle: unknown): number | undefined;
}

export interface CompilerInstallation {
	/** Absolute runtime source tree owned by this compiler installation. */
	runtimeDirectory: string;
	/** License notice copied into deployable artifacts. */
	licensePath?: string;
	/** Source implementation supplied for the virtual maligator:test module. */
	testModulePath: string;
	/** Node-compatible globals installed before applications and interpreted tests. */
	nodeGlobalsPath: string;
	/** Cache identity of the active TypeScript erasure frontend. */
	frontendIdentity: string;
	/** Prebuilt multi-call executable capable of running development wire images. */
	developmentRunner?: {
		executablePath: string;
		primordials: "locked" | "mutable";
		webPlatform: boolean;
		node: boolean;
		realms: boolean;
		intl: boolean;
		externalAssets: boolean;
		scheduler: "single" | "multiprocessing";
	};
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
		nodeGlobalsPath: path.join(sourceDirectory, "node-globals.mjs"),
		frontendIdentity: TYPE_STRIPPER_IDENTITY,
		evalCompiler: {
			kind: "source",
			sourceDirectory,
			entrypoint: path.join(sourceDirectory, "compiler/pipeline/eval-compiler-entry.mts"),
		},
	};
}

export function productCompilerInstallation(
	runtimeDirectory: string,
	compilerWirePath: string,
	testModulePath: string,
	licensePath?: string,
	developmentRunnerPath?: string,
	nodeGlobalsPath?: string,
): CompilerInstallation {
	return {
		runtimeDirectory: path.resolve(runtimeDirectory),
		...(licensePath === undefined ? {} : { licensePath: path.resolve(licensePath) }),
		testModulePath: path.resolve(testModulePath),
		nodeGlobalsPath: path.resolve(
			nodeGlobalsPath ?? path.join(path.dirname(testModulePath), "node-globals.mjs"),
		),
		frontendIdentity: TYPE_STRIPPER_IDENTITY,
		...(developmentRunnerPath === undefined
			? {}
			: {
					developmentRunner: {
						executablePath: path.resolve(developmentRunnerPath),
						primordials: "locked" as const,
						webPlatform: true,
						node: true,
						realms: true,
						intl: false,
						externalAssets: true,
						scheduler: "single" as const,
					},
				}),
		evalCompiler: { kind: "prebuilt", wirePath: path.resolve(compilerWirePath) },
	};
}

export interface BuildCommandResult {
	binaryPath?: string;
	serializedPath?: string;
	artifactDirectory?: string;
	runArguments?: Array<string>;
	dependencies?: Array<string>;
	profile?: PreparedProfile;
}

class CommandError extends Error {
	exitCode: number;

	constructor(message: string, exitCode = 1) {
		super(message);
		Object.defineProperty(this, "name", { value: "CommandError", configurable: true });
		this.exitCode = exitCode;
	}
}

function commandError(message: string, exitCode = 1): never {
	throw new CommandError(message, exitCode);
}

function writeStderr(message: string): void {
	process.stderr.write(`${message}\n`);
}

type ProfileCommand = BuildCommand | RunCommand | DevCommand | TestCommand;

function compilerProfileBuildEnvironment(command: ProfileCommand): NodeJS.ProcessEnv {
	return command.profileCompiler === true
		? { ...process.env, MAL_PERF_STATS: "1" }
		: process.env;
}

function compilerProfileRuntimeEnvironment(
	command: ProfileCommand,
): Record<string, string> {
	return command.profileCompiler === true ? { MAL_PROFILE_COMPILER: "1" } : {};
}

function loadCommandConfig(
	command: BuildCommand | RunCommand | DevCommand | TestCommand,
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
	command: BuildCommand | RunCommand | DevCommand,
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

function configNeedsCxx(config: ResolvedBuildConfig): boolean {
	return config.surface.webPlatform || config.surface.node;
}

function selectToolchain(
	command: BuildCommand | RunCommand | DevCommand,
	config: ResolvedBuildConfig,
	context: CommandContext,
): { toolchain?: Toolchain; plan?: NativeBuildPlan } {
	if (command.kind === "build" && command.internal.serializePath !== undefined) return {};
	if (
		command.kind !== "build" &&
		!command.profile &&
		compatibleDevelopmentRunner(config, context) !== undefined
	) {
		return {};
	}
	const selectionKey = JSON.stringify({
		needsCxx: configNeedsCxx(config),
		target: command.kind === "build" ? command.target : undefined,
		production: command.profile || (command.kind === "build" && command.production),
	});
	const retained = context.developmentCache?.toolchains.get(selectionKey);
	if (retained !== undefined) return retained;
	try {
		const toolchain = requireToolchain({
			needsCxx: configNeedsCxx(config),
			rustDir: path.join(context.installation.runtimeDirectory, "rust"),
			target: command.kind === "build" ? command.target : undefined,
		});
		const plan = selectNativeBuildPlan(
			toolchain,
			command.profile || (command.kind === "build" && command.production),
		);
		const selection = { toolchain, plan };
		context.developmentCache?.toolchains.set(selectionKey, selection);
		return selection;
	} catch (error) {
		if (error instanceof ToolchainError) commandError(error.message);
		throw error;
	}
}

function compatibleDevelopmentRunner(
	config: ResolvedBuildConfig,
	context: CommandContext,
): NonNullable<CompilerInstallation["developmentRunner"]> | undefined {
	const runner = context.installation.developmentRunner;
	if (
		runner === undefined ||
		(Object.keys(config.assets).length > 0 && !runner.externalAssets) ||
		config.engine.primordials !== runner.primordials ||
		(config.surface.webPlatform && !runner.webPlatform) ||
		(config.surface.node && !runner.node) ||
		(config.engine.realms && !runner.realms) ||
		(config.engine.intl.enabled && !runner.intl) ||
		config.host.scheduler !== runner.scheduler
	) {
		return undefined;
	}
	return runner;
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
	command: BuildCommand | RunCommand | DevCommand,
	context: CommandContext,
	compact = false,
): BuildCommandResult {
	const buildConfig = loadCommandConfig(command, context.stripTypes);
	const entrypointPath = resolveEntrypoint(command, buildConfig);
	const name =
		command.kind === "build"
			? (command.internal.name ?? resolveOutputName(buildConfig))
			: resolveOutputName(buildConfig);
	const verbose = command.kind === "build" ? command.internal.verbose : command.verbose;
	const reporter = new BuildReporter(verbose, compact && !verbose);
	const production = command.profile || (command.kind === "build" && command.production);
	reporter.start(
		name,
		production ? "production" : "development",
		command.kind !== "build" ? "Preparing" : "Building",
	);
	reporter.detail(
		"Profile",
		command.profile
			? command.profileCompiler === true
				? "compiler counters"
				: "sampling"
			: "disabled",
	);
	reporter.detail("Entrypoint", entrypointPath);
	reporter.detail("Config", command.configPath ?? "automatic/default");
	reporter.detail(
		"Surface",
		`web ${buildConfig.surface.webPlatform ? "on" : "off"}, node ${buildConfig.surface.node ? "on" : "off"}, maligator ${buildConfig.surface.maligator ? "on" : "off"}`,
	);
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
	const frontendSession = context.frontendSession ?? new FrontendCompilationSession();
	frontendSession.useCacheDirectory();
	const assets = reporter.phase("Collect assets", () => {
		try {
			return includeConfiguredAssets(buildConfig.assets, process.cwd(), {
				cacheDirectory: maligatorCacheDirectory(),
				session: frontendSession,
			});
		} catch (error) {
			if (error instanceof BuildConfigError) commandError(`error: ${error.message}`);
			throw error;
		}
	});
	const assetManifest = reporter.phase("Prepare development assets", () =>
		command.kind === "build" ? undefined : cacheDevelopmentAssets(assets),
	);
	const { toolchain, plan } = reporter.phase("Resolve toolchain", () =>
		selectToolchain(command, buildConfig, context),
	);
	if (toolchain !== undefined) {
		reporter.detail("Target", toolchain.target);
		reporter.detail(
			"C compiler",
			`${formatToolCommand(toolchain.tools.cc)} (${toolchain.tools.cc.version})`,
		);
		reporter.detail(
			"Rust compiler",
			`${formatToolCommand(toolchain.tools.rustc)} (${toolchain.tools.rustc.version})`,
		);
		reporter.detail("Toolchain cache", toolchain.cacheHit ? "hit" : "miss");
	}
	for (const warning of plan?.warnings ?? []) reporter.warning(warning);

	const compilerDiagnostics = command.kind === "build" && command.internal.dumpCore;
	const compilerPhases: Array<{ phase: string; durationMs: number }> = [];
	const frontend = reporter.phase(
		"Compile modules",
		() => {
			try {
				return compileBuildFrontend({
					entrypoint: entrypointPath,
					config: buildConfig,
					...(buildConfig.surface.node
						? {
								nodeGlobalsSource: readFileSync(
									context.installation.nodeGlobalsPath,
									"utf-8",
								),
							}
						: {}),
					stripTypes: context.stripTypes,
					stripperIdentity: context.installation.frontendIdentity,
					session: frontendSession,
					optimization: production ? "full" : "development",
					...(command.kind === "build" &&
					command.internal.optimizationAblations.length > 0
						? {
								optimizationAblations: new Set(command.internal.optimizationAblations),
							}
						: {}),
					// Debug builds pay per-pass Core verification so a broken transform
					// names its own pass instead of surfacing at a later boundary.
					...(debugEnabled ? { coreVerification: "per-pass" as const } : {}),
					profile: command.profile,
					enforcePolicies: !(
						command.kind === "build" && command.internal.serializePath !== undefined
					),
					// Profile metadata is derived from the optimized semantic program and is
					// not part of the portable wire schema yet. Do not accept a definition-only
					// frontend cache hit that would discard its source-site identities.
					forceCompile: debugEnabled || compilerDiagnostics || command.profile,
					relocatable: command.kind !== "build" && !command.profile,
					onCompilePhase: (phase, durationMs) => {
						compilerPhases.push({ phase, durationMs });
					},
					dependencyWorker: context.dependencyWorker,
					afterCoreOptimization: (core) => {
						if (command.kind === "build" && compilerDiagnostics) {
							log.info(core.functions.map(formatCoreFunction).join("\n"));
						}
					},
				});
			} catch (error) {
				if (error instanceof BuildConfigError) commandError(`error: ${error.message}`);
				throw error;
			}
		},
		(result) => `frontend cache ${result.cache}`,
	);
	reporter.detail("Frontend cache", `${frontend.cache} (${frontend.frontendMs}ms)`);
	for (const diagnostic of frontend.diagnostics) {
		reporter.warning(
			`${diagnostic.path}:${diagnostic.line}:${diagnostic.column} ` +
				`[${diagnostic.code}] ${diagnostic.message}`,
		);
	}
	reporter.detail(
		"Module parses",
		`${frontend.moduleParses.hits} reused, ${frontend.moduleParses.misses} parsed`,
	);
	reporter.detail(
		"File digests",
		`${frontend.fileDigests.hits} reused, ${frontend.fileDigests.misses} hashed`,
	);
	reporter.detail(
		"Frontend phases",
		`validation ${frontend.phases.validationMs}ms, graph ${frontend.phases.graphMs}ms, ` +
			`semantic ${frontend.phases.semanticMs}ms, compile ${frontend.phases.compileMs}ms, ` +
			`serialize ${frontend.phases.serializeMs}ms, workers ${frontend.phases.workerMs}ms`,
	);
	if (frontend.fragmentArtifacts !== undefined) {
		reporter.detail(
			"Development fragments",
			`${frontend.fragmentArtifacts.hits} reused, ${frontend.fragmentArtifacts.misses} compiled`,
		);
	}
	if (frontend.fragmentFallback !== undefined) {
		reporter.detail(
			"Development fragments",
			`whole-image fallback · ${frontend.fragmentFallback}`,
		);
	}
	for (const phase of compilerPhases) {
		reporter.timing(`Compiler phase · ${phase.phase}`, phase.durationMs);
	}
	const dependencies = [
		...new Set([
			...frontend.dependencies,
			...assets.flatMap((asset) => asset.files.map((file) => file.inputPath)),
		]),
	].sort();
	reporter.detail("Dependencies", dependencies.length);
	for (const dependency of dependencies) reporter.detail("Dependency", dependency);

	const stats = frontend.imageStats;
	reporter.detail("Functions", stats.functionCount);
	reporter.detail("Instructions", stats.instructionCount);

	const serializePath =
		command.kind === "build" ? command.internal.serializePath : undefined;
	if (serializePath !== undefined) {
		reporter.phase("Write runtime image", () =>
			writeFileSync(serializePath, frontend.wire),
		);
		reporter.detail("Serialized bytes", frontend.wire.length);
		reporter.complete("Serialized", serializePath, true);
		return { serializedPath: serializePath, dependencies };
	}

	const packagedRunner =
		command.kind !== "build" && !command.profile
			? compatibleDevelopmentRunner(buildConfig, context)
			: undefined;
	if (command.kind !== "build" && packagedRunner !== undefined) {
		const wirePaths = reporter.phase("Cache development image", () =>
			frontend.artifacts.map((artifact) => artifact.path),
		);
		const surfaceMask =
			(buildConfig.surface.webPlatform ? 1 : 0) | (buildConfig.surface.node ? 2 : 0);
		reporter.detail("Execution backend", "packaged development runtime");
		reporter.detail("Development images", wirePaths.join(", "));
		reporter.complete("Ready", packagedRunner.executablePath, false);
		return {
			binaryPath: packagedRunner.executablePath,
			runArguments: [
				assetManifest === undefined
					? "--maligator-internal-run-wire"
					: "--maligator-internal-run-wire-assets",
				String(surfaceMask),
				String(wirePaths.length),
				...(assetManifest === undefined ? [] : [assetManifest]),
				entrypointPath,
				...wirePaths,
				...command.programArgs,
			],
			dependencies,
		};
	}

	const evalCompiler = context.installation.evalCompiler;
	const compilerBake =
		evalCompiler.kind === "source"
			? {
					kind: "source" as const,
					sourceDirectory: evalCompiler.sourceDirectory,
					entrypoint: evalCompiler.entrypoint,
					sourceFiles: compilerEntrypointSourceFiles(
						evalCompiler.sourceDirectory,
						evalCompiler.entrypoint,
						context.stripTypes,
					),
					bake: () =>
						compileEntrypointToBuffer(evalCompiler.entrypoint, {
							stripTypes: context.stripTypes,
						}),
				}
			: { kind: "prebuilt" as const, path: evalCompiler.wirePath };
	const baseDerivation = buildDerivationFromConfig(buildConfig);
	const derivation = command.profile
		? {
				features: normalizeNativeFeatures({
					...baseDerivation.features,
					profileEnabled: true,
				}),
				cacheSuffix: [
					baseDerivation.cacheSuffix,
					"profile",
					command.profileCompiler ? "compiler" : "",
				]
					.filter((part) => part !== "")
					.join("-"),
			}
		: baseDerivation;
	reporter.detail(
		"Rust features",
		derivation.features.cargoFeatures.length === 0
			? "(none)"
			: derivation.features.cargoFeatures.join(", "),
	);
	const nativeEnvironment = compilerProfileBuildEnvironment(command);
	reporter.detail("Native compile jobs", nativeBuildJobs(nativeEnvironment));
	const nativeCache = new Map<"runtime" | "rust" | "binary", boolean>();
	let generatedObjects = 0;
	let generatedObjectHits = 0;
	const nativeContext = resolveNativeBuildContext({
		environment: nativeEnvironment,
		toolchain,
		plan,
		runtimeDirectory: context.installation.runtimeDirectory,
		features: derivation.features,
		compilerBake,
		onCacheEvent: (event) => {
			nativeCache.set(event.artifact, event.hit);
			reporter.detail(
				`${event.artifact === "rust" ? "Rust" : event.artifact === "runtime" ? "Runtime" : "Binary"} cache`,
				`${event.hit ? "hit" : "miss"} (${event.path})`,
			);
		},
		onBuildPhase: (event) => {
			reporter.timing(
				`Native phase · ${event.phase}`,
				event.durationMs,
				[
					event.cache === undefined ? undefined : `cache ${event.cache}`,
					event.units === undefined ? undefined : `${event.units} units`,
					event.path,
				]
					.filter((value) => value !== undefined)
					.join(" · ") || undefined,
			);
		},
		onCommand: (event) => {
			const commandLine = [event.tool, ...event.args]
				.map((argument) =>
					/^[A-Za-z0-9_./:@%+=,-]+$/.test(argument) ? argument : JSON.stringify(argument),
				)
				.join(" ");
			reporter.detail(
				"Command",
				event.cwd === undefined ? commandLine : `(cd ${event.cwd}) ${commandLine}`,
			);
		},
	});
	if (command.kind !== "build" && !command.profile) {
		const wirePaths = reporter.phase("Cache development image", () =>
			frontend.artifacts.map((artifact) => artifact.path),
		);
		reporter.detail("Execution backend", "interpreted development image");
		reporter.detail("Development images", wirePaths.join(", "));
		const runnerKey = `${toolchain!.fingerprint}:${derivation.cacheSuffix}`;
		const retainedRunner = context.developmentCache?.runners.get(runnerKey);
		const binaryPath = reporter.phase(
			"Prepare development runtime",
			() => {
				if (retainedRunner !== undefined && existsSync(retainedRunner)) {
					reporter.detail("Development runtime cache", "retained");
					return retainedRunner;
				}
				const built = buildDevelopmentRunner(
					nativeContext,
					verbose,
					derivation.cacheSuffix,
				).binaryPath;
				context.developmentCache?.runners.set(runnerKey, built);
				return built;
			},
			() => {
				const caches = (["runtime", "rust", "binary"] as const)
					.map((artifact) =>
						nativeCache.has(artifact)
							? `${artifact} ${nativeCache.get(artifact) ? "hit" : "miss"}`
							: undefined,
					)
					.filter((value) => value !== undefined);
				return caches.join(" · ");
			},
		);
		reporter.complete("Ready", binaryPath, false);
		return {
			binaryPath,
			runArguments: [
				assetManifest === undefined
					? "--maligator-internal-run-wires"
					: "--maligator-internal-run-wires-assets",
				String(wirePaths.length),
				...(assetManifest === undefined ? [] : [assetManifest]),
				entrypointPath,
				...wirePaths,
				...command.programArgs,
			],
			dependencies,
		};
	}

	const programImage = frontend.programImage;
	const output = reporter.phase("Generate native code", () =>
		emitProgramTranslationUnits(programImage, {
			compiled: command.kind !== "build" || command.internal.compiled,
			assets,
			maligatorSurface: buildConfig.surface.maligator,
		}),
	);
	if (command.kind === "build" && command.internal.emitC) log.info(output.join("\n"));
	reporter.detail("Translation units", output.length);
	reporter.detail(
		"Generated C bytes",
		output.reduce((total, source) => total + source.length, 0),
	);
	const binaryPath = reporter.phase(
		"Build native binary",
		() =>
			buildLocalBinary({
				context: nativeContext,
				name,
				cSource: output,
				verbose,
				onWarning: (warning) => reporter.warning(warning),
				onGeneratedObjectCacheEvent: (event) => {
					generatedObjects++;
					if (event.hit) generatedObjectHits++;
					reporter.detail(
						"Generated object cache",
						`${event.hit ? "hit" : "miss"} (${event.path})`,
					);
				},
				mainFile: applicationDriverPath(
					context.installation,
					buildConfig.surface.webPlatform,
					buildConfig.surface.node,
				),
				cacheSuffix: derivation.cacheSuffix,
			}).binaryPath,
		() => {
			const caches = (["runtime", "rust", "binary"] as const)
				.map((artifact) =>
					nativeCache.has(artifact)
						? `${artifact} ${nativeCache.get(artifact) ? "hit" : "miss"}`
						: undefined,
				)
				.filter((value) => value !== undefined);
			caches.push(`${generatedObjectHits}/${generatedObjects} objects cached`);
			return caches.join(" · ");
		},
	);
	const preparedProfile = command.profile
		? reporter.phase("Prepare profile metadata", () =>
				prepareProfile(
					binaryPath,
					frontend.programImage,
					command.profileCompiler === true ? "compiler" : "sampling",
				),
			)
		: undefined;
	let resultPath = binaryPath;
	if (command.kind === "build" && command.artifactDirectory !== undefined) {
		const artifactDirectory = command.artifactDirectory;
		const artifact = reporter.phase("Create artifact", () => {
			try {
				return createBuildArtifact({
					binaryPath,
					directory: artifactDirectory,
					executableName: name,
					licensePath: context.installation.licensePath,
					version: MALIGATOR_VERSION,
					target: nativeContext.toolchain.rustTarget,
					production: true,
					additionalFiles:
						preparedProfile === undefined
							? undefined
							: [
									{
										sourcePath: `${binaryPath}.profile.json`,
										path: "profile.json",
									},
								],
				});
			} catch (error) {
				commandError(
					`error: could not create artifact: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		});
		resultPath = artifact.directory;
		reporter.complete("Built", resultPath, true);
		return {
			binaryPath,
			artifactDirectory: artifact.directory,
			dependencies,
			...(preparedProfile === undefined ? {} : { profile: preparedProfile }),
		};
	}
	reporter.complete(
		command.kind !== "build" ? "Ready" : "Built",
		resultPath,
		command.kind === "build",
	);
	return {
		binaryPath,
		dependencies,
		...(preparedProfile === undefined ? {} : { profile: preparedProfile }),
	};
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
	const capture =
		command.profile && result.profile !== undefined
			? createProfileCapture("run", result.profile)
			: undefined;
	if (gmallocEnabled()) log.info("Running under Guard Malloc (MAL_GMALLOC).");
	const outcome = executeBinary(binaryPath, result.runArguments ?? command.programArgs, {
		...runEnv(),
		...(capture === undefined ? {} : capture.environment),
		...compilerProfileRuntimeEnvironment(command),
	});
	if (capture !== undefined && result.profile !== undefined) {
		if (existsSync(capture.capturePath)) {
			try {
				const finalized = finalizeProfileCapture(
					capture.directory,
					result.profile,
					"run",
				);
				writeStderr(`Profile ${capture.directory}`);
				for (const line of formatProfileReport(finalized)) writeStderr(line);
			} catch (error) {
				writeStderr(
					`warning: profile capture could not be finalized: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		} else {
			writeStderr(`warning: profiled process did not publish ${capture.capturePath}`);
		}
	}
	if (outcome.status === 0) {
		writeStderr("Exited with code 0");
		return;
	}
	writeStderr(
		`Exited with ${outcome.signal ? `signal ${outcome.signal}` : `code ${outcome.status ?? "unknown"}`}`,
	);
	if (outcome.signal !== undefined) process.kill(process.pid, outcome.signal);
	process.exit(outcome.status ?? 1);
}

interface WatchedFileState {
	file: string;
	identity: string | undefined;
	external: boolean;
}

function watchIdentity(file: string): string | undefined {
	try {
		const stats = statSync(file);
		return stats.isFile() ? `${stats.size}:${stats.mtimeMs}` : undefined;
	} catch {
		return undefined;
	}
}

function watchedFiles(
	command: DevCommand,
	dependencies: Array<string>,
): Array<WatchedFileState> {
	const configPath = path.resolve(command.configPath ?? BUILD_CONFIG_NAME);
	const files = new Set(dependencies);
	if (existsSync(configPath) || command.configPath !== undefined) files.add(configPath);
	return [...files].sort().map((file) => ({
		file,
		identity: watchIdentity(file),
		external: file.split(path.sep).includes("node_modules"),
	}));
}

function changedFiles(
	states: Array<WatchedFileState>,
	includeExternal: boolean,
): Array<string> {
	return states
		.filter(
			(state) =>
				(includeExternal || !state.external) &&
				watchIdentity(state.file) !== state.identity,
		)
		.map((state) => state.file);
}

function delay(durationMs: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, durationMs);
	});
}

async function stopDevelopmentProcess(
	host: DevelopmentProcessHost,
	handle: unknown,
): Promise<void> {
	host.kill(handle, false);
	for (let attempt = 0; attempt < 50; attempt++) {
		if (host.status(handle) !== undefined) return;
		await delay(10);
	}
	host.kill(handle, true);
	for (let attempt = 0; attempt < 50; attempt++) {
		if (host.status(handle) !== undefined) return;
		await delay(10);
	}
	throw new Error("development application did not stop after forced termination");
}

function formatDevelopmentDuration(durationMs: number): string {
	return durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`;
}

/** Retain frontend identities while restarting a fresh application VM on edits. */
export async function devCommand(
	command: DevCommand,
	context: CommandContext,
): Promise<void> {
	const processHost = context.developmentProcesses;
	if (processHost === undefined) {
		commandError("error: this Maligator installation does not provide watch processes");
	}
	const session = context.frontendSession ?? new FrontendCompilationSession();
	const retainedContext = {
		...context,
		frontendSession: session,
		developmentCache: context.developmentCache ?? {
			toolchains: new Map(),
			runners: new Map(),
		},
	};
	const initialBuildStartedAt = Date.now();
	let result = compileAndBuild(command, retainedContext, true);
	let profileGeneration = 0;
	let activeProfile:
		| {
				prepared: PreparedProfile;
				directory: string;
				capturePath: string;
				environment: {
					MAL_PROFILE_CAPTURE: string;
					MAL_PROFILE_IDENTITY: string;
				};
		  }
		| undefined;
	const nextProfile = (build: BuildCommandResult) => {
		if (!command.profile || build.profile === undefined) return undefined;
		profileGeneration++;
		const capture = createProfileCapture(`dev-${profileGeneration}`, build.profile);
		return { prepared: build.profile, ...capture };
	};
	const finalizeActiveProfile = (): void => {
		if (activeProfile === undefined) return;
		if (existsSync(activeProfile.capturePath)) {
			try {
				const finalized = finalizeProfileCapture(
					activeProfile.directory,
					activeProfile.prepared,
					"dev",
				);
				writeStderr(`Profile ${activeProfile.directory}`);
				for (const line of formatProfileReport(finalized)) writeStderr(line);
			} catch (error) {
				writeStderr(
					`warning: development profile could not be finalized: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		} else {
			writeStderr(
				`warning: development generation did not publish ${activeProfile.capturePath}`,
			);
		}
		activeProfile = undefined;
	};
	let states = watchedFiles(command, result.dependencies ?? []);
	const watchHost = context.developmentWatcher;
	const watchHandle = watchHost?.create(states.map((state) => state.file));
	activeProfile = nextProfile(result);
	let child: unknown = processHost.spawn(
		result.binaryPath!,
		result.runArguments ?? command.programArgs,
		activeProfile === undefined
			? undefined
			: {
					...activeProfile.environment,
					...compilerProfileRuntimeEnvironment(command),
				},
	);
	let stopping = false;
	const stop = () => {
		stopping = true;
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	writeStderr(
		`Ready in ${formatDevelopmentDuration(Date.now() - initialBuildStartedAt)} · watching ${states.length} files · press Ctrl+C to stop`,
	);
	if (command.verbose) {
		writeStderr(
			`Watcher: ${watchHost === undefined ? "polling fallback" : "filesystem events"}`,
		);
	}
	let poll = 0;

	try {
		while (!stopping) {
			if (watchHost === undefined) await delay(75);
			else await watchHost.wait(watchHandle, 50);
			const changed = changedFiles(states, watchHost !== undefined || poll++ % 14 === 0);
			if (changed.length === 0) {
				const status = child === undefined ? undefined : processHost.status(child);
				if (child !== undefined && status !== undefined) {
					writeStderr(
						`Application ${status === 0 ? "stopped" : "crashed"} with code ${status}; waiting for changes.`,
					);
					finalizeActiveProfile();
					child = undefined;
				}
				continue;
			}

			await delay(25);
			const settledChanges = new Set(changed);
			for (const file of changedFiles(states, true)) settledChanges.add(file);
			const changedPaths = [...settledChanges];
			writeStderr(
				`Changed ${changedPaths.map((file) => path.relative(process.cwd(), file)).join(", ")}`,
			);
			for (const file of changedPaths) session.invalidate(file);
			if (changedPaths.includes(path.resolve(command.configPath ?? BUILD_CONFIG_NAME))) {
				session.invalidate();
			}
			states = states.map((state) => ({
				...state,
				identity: watchIdentity(state.file),
			}));
			try {
				const rebuildStartedAt = Date.now();
				result = compileAndBuild(command, retainedContext, true);
				states = watchedFiles(command, result.dependencies ?? []);
				watchHost?.update(
					watchHandle,
					states.map((state) => state.file),
				);
				if (child !== undefined) {
					await stopDevelopmentProcess(processHost, child);
					finalizeActiveProfile();
					child = undefined;
				}
				activeProfile = nextProfile(result);
				child = processHost.spawn(
					result.binaryPath!,
					result.runArguments ?? command.programArgs,
					activeProfile === undefined
						? undefined
						: {
								...activeProfile.environment,
								...compilerProfileRuntimeEnvironment(command),
							},
				);
				writeStderr(
					`Compiled in ${formatDevelopmentDuration(Date.now() - rebuildStartedAt)} · restarted`,
				);
			} catch (error) {
				writeStderr(
					`Rebuild failed: ${error instanceof Error ? error.message : String(error)}${
						child === undefined ? "" : "; last successful application is still running"
					}`,
				);
			}
		}
	} finally {
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
		watchHost?.close(watchHandle);
		if (child !== undefined && processHost.status(child) === undefined) {
			await stopDevelopmentProcess(processHost, child);
		}
		finalizeActiveProfile();
	}
}

const PROFILED_TEST_RESULT_PREFIX = "__MALIGATOR_TEST_RESULT__";

function executeIsolatedTests(
	command: TestCommand,
	context: CommandContext,
	config: ResolvedBuildConfig,
): TestCommandSummary {
	const compiled = prepareIsolatedTestCommand(command, context, config);
	const derivation = buildDerivationFromConfig(config);
	let toolchain: Toolchain;
	try {
		toolchain = requireToolchain({
			needsCxx: configNeedsCxx(config),
			rustDir: path.join(context.installation.runtimeDirectory, "rust"),
		});
	} catch (error) {
		if (error instanceof ToolchainError) commandError(error.message);
		throw error;
	}
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
	const nativeContext = resolveNativeBuildContext({
		toolchain,
		plan: selectNativeBuildPlan(toolchain, false),
		runtimeDirectory: context.installation.runtimeDirectory,
		features: derivation.features,
		compilerBake,
	});
	const runner = buildDevelopmentRunner(
		nativeContext,
		false,
		derivation.cacheSuffix,
	).binaryPath;
	const wirePath = cacheFrontendWire(compiled.wire);
	const assets = includeConfiguredAssets(config.assets, process.cwd(), {
		cacheDirectory: ".cache/mal-cache",
		session: new FrontendCompilationSession(),
	});
	const assetManifest = cacheDevelopmentAssets(assets);
	const entrypoint = compiled.files[0]!;
	const args = [
		assetManifest === undefined
			? "--maligator-internal-run-wires"
			: "--maligator-internal-run-wires-assets",
		"1",
		...(assetManifest === undefined ? [] : [assetManifest]),
		entrypoint,
		wirePath,
	];
	const executionStartedAt = Date.now();
	const outcome = executeBinaryCaptured(runner, args, runEnv());
	const executionMs = Date.now() - executionStartedAt;
	if (outcome.stderr !== "") process.stderr.write(outcome.stderr);
	const outputLines = outcome.stdout.split("\n");
	const resultLine = outputLines.find((line) =>
		line.startsWith(ISOLATED_TEST_RESULT_PREFIX),
	);
	const applicationOutput = outputLines
		.filter((line) => !line.startsWith(ISOLATED_TEST_RESULT_PREFIX))
		.join("\n");
	if (applicationOutput !== "") process.stdout.write(applicationOutput);
	if (outcome.status !== 0 || resultLine === undefined) {
		commandError(
			`error: isolated test process ${
				outcome.signal
					? `received ${outcome.signal}`
					: `exited with ${outcome.status ?? "unknown"}`
			}${resultLine === undefined ? " without publishing a test result" : ""}`,
		);
	}
	let testResult: TestRunResult;
	try {
		testResult = JSON.parse(
			resultLine.slice(ISOLATED_TEST_RESULT_PREFIX.length),
		) as TestRunResult;
	} catch (error) {
		commandError(
			`error: isolated test result was invalid: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return reportIsolatedTestResult(testResult, {
		files: compiled.files.length,
		discoveryMs: compiled.discoveryMs,
		frontendMs: compiled.frontendMs,
		executionMs,
	});
}

function executeProfiledTests(
	command: TestCommand,
	context: CommandContext,
	config: ResolvedBuildConfig,
): TestCommandSummary {
	const compiled = prepareProfiledTestCommand(command, context, config);
	const baseDerivation = buildDerivationFromConfig(config);
	const derivation = {
		features: normalizeNativeFeatures({
			...baseDerivation.features,
			profileEnabled: true,
		}),
		cacheSuffix: [
			baseDerivation.cacheSuffix,
			"profile-test",
			command.profileCompiler ? "compiler" : "",
		]
			.filter((part) => part !== "")
			.join("-"),
	};
	let toolchain: Toolchain;
	try {
		toolchain = requireToolchain({
			needsCxx: configNeedsCxx(config),
			rustDir: path.join(context.installation.runtimeDirectory, "rust"),
		});
	} catch (error) {
		if (error instanceof ToolchainError) commandError(error.message);
		throw error;
	}
	const evalCompiler = context.installation.evalCompiler;
	const compilerBake =
		evalCompiler.kind === "source"
			? {
					kind: "source" as const,
					sourceDirectory: evalCompiler.sourceDirectory,
					entrypoint: evalCompiler.entrypoint,
					sourceFiles: compilerEntrypointSourceFiles(
						evalCompiler.sourceDirectory,
						evalCompiler.entrypoint,
						context.stripTypes,
					),
					bake: () =>
						compileEntrypointToBuffer(evalCompiler.entrypoint, {
							stripTypes: context.stripTypes,
						}),
				}
			: { kind: "prebuilt" as const, path: evalCompiler.wirePath };
	const nativeContext = resolveNativeBuildContext({
		environment: compilerProfileBuildEnvironment(command),
		toolchain,
		plan: selectNativeBuildPlan(toolchain, true),
		runtimeDirectory: context.installation.runtimeDirectory,
		features: derivation.features,
		compilerBake,
	});
	const assets = includeConfiguredAssets(config.assets, process.cwd(), {
		cacheDirectory: maligatorCacheDirectory(),
		session: new FrontendCompilationSession(),
	});
	const source = emitProgramTranslationUnits(compiled.programImage, {
		compiled: true,
		assets,
		maligatorSurface: config.surface.maligator,
	});
	const binary = buildLocalBinary({
		context: nativeContext,
		name: "maligator-profile-test",
		cSource: source,
		verbose: false,
		mainFile: applicationDriverPath(
			context.installation,
			config.surface.webPlatform,
			config.surface.node,
		),
		cacheSuffix: derivation.cacheSuffix,
	}).binaryPath;
	const profile = prepareProfile(
		binary,
		compiled.programImage,
		command.profileCompiler === true ? "compiler" : "sampling",
	);
	const capture = createProfileCapture("test", profile);
	const executionStartedAt = Date.now();
	const outcome = executeBinaryCaptured(binary, [], {
		...runEnv(),
		...capture.environment,
		...compilerProfileRuntimeEnvironment(command),
	});
	const executionMs = Date.now() - executionStartedAt;
	if (outcome.stderr !== "") process.stderr.write(outcome.stderr);
	const outputLines = outcome.stdout.split("\n");
	const resultLine = outputLines.find((line) =>
		line.startsWith(PROFILED_TEST_RESULT_PREFIX),
	);
	const applicationOutput = outputLines
		.filter((line) => !line.startsWith(PROFILED_TEST_RESULT_PREFIX))
		.join("\n");
	if (applicationOutput !== "") process.stdout.write(applicationOutput);
	if (outcome.status !== 0 || resultLine === undefined) {
		commandError(
			`error: production-profile test process ${
				outcome.signal
					? `received ${outcome.signal}`
					: `exited with ${outcome.status ?? "unknown"}`
			}${resultLine === undefined ? " without publishing a test result" : ""}`,
		);
	}
	let testResult: TestRunResult;
	try {
		testResult = JSON.parse(
			resultLine.slice(PROFILED_TEST_RESULT_PREFIX.length),
		) as TestRunResult;
	} catch (error) {
		commandError(
			`error: production-profile test result was invalid: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (existsSync(capture.capturePath)) {
		const finalized = finalizeProfileCapture(capture.directory, profile, "test");
		writeStderr(`Profile ${capture.directory}`);
		for (const line of formatProfileReport(finalized)) writeStderr(line);
	} else {
		writeStderr(`warning: profiled tests did not publish ${capture.capturePath}`);
	}
	return reportProfiledTestResult(testResult, {
		files: compiled.files.length,
		discoveryMs: compiled.discoveryMs,
		frontendMs: compiled.frontendMs,
		executionMs,
	});
}

/** Product command dispatcher shared by the Node CLI and the compiled bootstrap. */
export async function runCli(
	args: Array<string>,
	context: CommandContext,
): Promise<void> {
	let verbose = false;
	let cacheLease: ReturnType<typeof createCacheLease> | undefined;
	try {
		if (args[0] === "--maligator-internal-dependency-fragment") {
			if (args.length !== 2) {
				throw new Error("dependency fragment worker requires one request path");
			}
			compileDependencyFragmentRequest(args[1]!, context.stripTypes);
			return;
		}
		if (args[0] === "--maligator-internal-linkage-validation") {
			if (args.length !== 2) {
				throw new Error("linkage validation worker requires one request path");
			}
			validateBuildFragmentRequest(args[1]!, context.stripTypes);
			return;
		}
		const command = parseCliArgs(args);
		if (
			command.kind !== "cache" &&
			command.kind !== "help" &&
			command.kind !== "version" &&
			command.kind !== "init"
		) {
			try {
				maybeMaintainMaligatorCache();
			} catch {
				// Automatic maintenance is best-effort. Explicit cache prune reports
				// active leases or other maintenance directly to the user.
			}
			cacheLease = createCacheLease(command.kind);
		}
		verbose =
			(command.kind === "build" && command.internal.verbose) ||
			((command.kind === "run" || command.kind === "dev") && command.verbose) ||
			(command.kind === "doctor" && command.verbose);
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
		if (command.kind === "cache") {
			runCacheCommand(command);
			return;
		}
		if (command.kind === "build") {
			buildCommand(command, context);
		} else if (command.kind === "run") {
			runCommand(command, context);
		} else if (command.kind === "dev") {
			await devCommand(command, context);
		} else {
			let result: Awaited<ReturnType<typeof executeTestCommand>>;
			try {
				const config = loadCommandConfig(command, context.stripTypes);
				// In-process interpretation only exists when this CLI is already hosted by a
				// development runner matching the project policy; every other installation,
				// including the Node-hosted source CLI, needs an isolated child runner.
				result = command.profile
					? executeProfiledTests(command, context, config)
					: compatibleDevelopmentRunner(config, context) === undefined
						? executeIsolatedTests(command, context, config)
						: await executeTestCommand(command, context, config);
			} catch (error) {
				commandError(`error: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (result.exitCode !== 0) process.exit(result.exitCode);
		}
	} catch (error) {
		if (error instanceof CliUsageError) {
			writeStderr(`error: ${error.message}`);
			writeStderr("Run 'maligator --help' for usage.");
			process.exit(2);
		}
		if (error instanceof CommandError) {
			writeStderr(error.message);
			process.exit(error.exitCode);
		}
		if (error instanceof MaligatorCacheRootError) {
			writeStderr(`error: ${error.message}`);
			process.exit(1);
		}
		if (verbose && error instanceof Error && error.stack !== undefined) {
			writeStderr(error.stack);
		} else {
			writeStderr(`error: ${error instanceof Error ? error.message : String(error)}`);
			writeStderr("Run again with '--verbose' for diagnostic details.");
		}
		process.exit(1);
	} finally {
		cacheLease?.release();
	}
}

function cacheSummaryLines(): Array<string> {
	const status = inspectMaligatorCache();
	const families = new Map<string, number>();
	for (const entry of status.entries) {
		families.set(entry.family, (families.get(entry.family) ?? 0) + entry.bytes);
	}
	const now = Date.now();
	return [
		`Root: ${status.root}`,
		`Total: ${formatCacheBytes(status.totalBytes)} (${formatCacheBytes(status.managedBytes)} managed)`,
		...[...families.entries()]
			.sort((left, right) => right[1] - left[1])
			.map(([family, bytes]) => `  ${family}: ${formatCacheBytes(bytes)}`),
		`Active commands: ${status.activeLeases}`,
		...status.activeCommands.map(
			(command) =>
				`  pid ${command.pid}: ${command.command} (${formatCommandDuration(now - command.startedAt)})`,
		),
	];
}

function runCacheCommand(command: CacheCommand): void {
	const progress = new CommandProgress("cache", { cacheLease: false });
	if (command.action === "status") {
		progress.start("inspect Maligator-owned cache");
		progress.stage(1, 1, "scan cache");
		for (const line of cacheSummaryLines()) log.info(line);
		progress.stagePassed(1, 1, "scan cache");
		progress.complete();
		return;
	}
	if (command.action === "clear") {
		progress.start("clear Maligator-owned rebuildable cache");
		progress.stage(1, 1, "remove rebuildable entries");
		const result = clearAllMaligatorCaches();
		progress.stagePassed(
			1,
			1,
			"remove rebuildable entries",
			`${result.removed.length} entries · ${formatCacheBytes(result.removedBytes)}`,
		);
		progress.complete();
		return;
	}

	const maxBytes = command.maxBytes ?? DEFAULT_CACHE_MAX_BYTES;
	const minAgeMs = command.minAgeMs ?? DEFAULT_CACHE_MIN_AGE_MS;
	progress.start(
		`${command.dryRun ? "preview" : "prune"} stale rebuildable entries · target ${formatCacheBytes(maxBytes)}`,
	);
	const maintenanceLabel = command.dryRun
		? "scan eligible entries"
		: "remove stale entries";
	progress.stage(1, 2, maintenanceLabel);
	const result = pruneMaligatorCache({
		maxBytes,
		minAgeMs,
		dryRun: command.dryRun,
	});
	progress.stagePassed(
		1,
		2,
		maintenanceLabel,
		`${result.removed.length} entries · ${formatCacheBytes(result.removedBytes)}`,
	);
	progress.stage(2, 2, command.dryRun ? "report preview" : "report result");
	const byFamily = new Map<string, { count: number; bytes: number }>();
	for (const entry of result.removed) {
		const summary = byFamily.get(entry.family) ?? { count: 0, bytes: 0 };
		summary.count++;
		summary.bytes += entry.bytes;
		byFamily.set(entry.family, summary);
		if (command.verbose) {
			log.info(
				`${command.dryRun ? "Would remove" : "Removed"} ${entry.path} (${formatCacheBytes(entry.bytes)})`,
			);
		}
	}
	for (const [family, summary] of [...byFamily].sort(
		(left, right) => right[1].bytes - left[1].bytes,
	)) {
		log.info(
			`${command.dryRun ? "Would remove" : "Removed"} ${summary.count} from ${family} (${formatCacheBytes(summary.bytes)})`,
		);
	}
	progress.stagePassed(
		2,
		2,
		command.dryRun ? "report preview" : "report result",
		`${formatCacheBytes(result.totalBytes)} remain`,
	);
	progress.complete();
}
