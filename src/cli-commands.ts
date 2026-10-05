import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type {
	ApplicationExit,
	ApplicationImageDescriptor,
	ApplicationImageHost,
} from "./application-images.ts";
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
import {
	compileBuildFrontend,
	compileBuildFrontendAsync,
} from "./build-frontend-cache.ts";
import type {
	BuildRootCompiler,
	CompileBuildFrontendOptions,
	CompiledBuildFrontend,
} from "./build-frontend-cache.ts";
import { BuildReporter } from "./build-progress.ts";
import {
	clearAllMaligatorCaches,
	createCacheLease,
	DEFAULT_CACHE_MAX_BYTES,
	DEFAULT_CACHE_MIN_AGE_MS,
	formatCacheBytes,
	inspectMaligatorCache,
	pruneMaligatorCache,
} from "./cache-management.ts";
import { maligatorCacheDirectory, MaligatorCacheRootError } from "./cache-root.ts";
import { BUILD_CONFIG_NAME, initProject, InitError } from "./cli-init.ts";
import { executeBinary, executeBinaryCaptured } from "./cli-run.ts";
import type { RunOutcome } from "./cli-run.ts";
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
import type { CompilationPhase, CompilerService } from "./compiler-service.ts";
import { formatCoreProgram } from "./compiler/core/core-ir.ts";
import { formatCoreOptimizationReport } from "./compiler/core/core-optimization-report.ts";
import {
	TYPE_STRIPPER_IDENTITY,
	stripCompactTypes,
} from "./compiler/frontend/compact-type-strip.ts";
import {
	compileEntrypoint,
	compileEntrypointToBuffer,
} from "./compiler/pipeline/compile-program.ts";
import { emitProgramTranslationUnits } from "./compiler/target/emit-program-image.ts";
import { emitWorkerImageTranslationUnits } from "./compiler/target/emit-worker-images.ts";
import { compileDependencyFragmentRequest } from "./dependency-fragment-cache.ts";
import type { DependencyFragmentWorker } from "./dependency-fragment-cache.ts";
import { cacheDevelopmentAssets } from "./development-assets.ts";
import { createDevelopmentSession } from "./development-session.ts";
import {
	cacheFrontendWire,
	frontendDependencyUnchanged,
	FrontendCompilationSession,
} from "./frontend-cache.ts";
import type { FrontendDependencyIdentity } from "./frontend-cache.ts";
import { buildDevelopmentRunner, buildLocalBinary } from "./local-build.ts";
import { resolveNativeBuildContext } from "./native-build-context.ts";
import { nativeBuildJobs } from "./native-command.ts";
import { nativeSourcePath } from "./native-source-path.ts";
import {
	executionTarget,
	hostExecutionTarget,
	resolveExecution,
} from "./platform/execution.ts";
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
import { watchTestCommand } from "./testing/watch.ts";
import {
	formatToolchainReport,
	formatToolCommand,
	inspectToolchain,
	requireToolchain,
	ToolchainError,
} from "./toolchain.ts";
import type { Toolchain } from "./toolchain.ts";
import { debugEnabled, log } from "./utils.ts";
import {
	cacheDevelopmentWorkerManifest,
	workerManifestArguments,
	writeSerializedWorkerManifest,
} from "./worker-image-cache.ts";

export interface CommandContext {
	stripTypes: BuildConfigTypeStripper;
	installation: CompilerInstallation;
	developmentProcesses?: DevelopmentProcessHost;
	developmentWatcher?: DevelopmentWatchHost;
	frontendSession?: FrontendCompilationSession;
	developmentCache?: DevelopmentBuildCache;
	dependencyWorker?: DependencyFragmentWorker;
	compiler?: CompilerService;
	rootCompiler?: BuildRootCompiler;
	availableCompileConcurrency?: number;
	rootCompilationSignal?: AbortSignal;
	applications?: ApplicationImageHost;
	checkpoint?: () => void;
	onCompilationPhase?: (event: CompilationPhase) => void;
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
	/** Installed source-module root used by the platform catalog. */
	platformSourceRoot?: string;
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
	/** Prebuilt executables capable of running compile-time-specialized wire images. */
	developmentRunners?: Array<{
		executablePath: string;
		inProcess: boolean;
		wireProtocol: "product" | "wire-list";
		primordials: "locked" | "mutable";
		webPlatform: boolean;
		node: boolean;
		eval: boolean;
		realms: boolean;
		regexp: boolean;
		temporal: boolean;
		intl: boolean;
		externalAssets: boolean;
	}>;
	evalCompiler:
		| { kind: "source"; sourceDirectory: string; entrypoint: string }
		| { kind: "prebuilt"; wirePath: string };
}

type DevelopmentRunner = NonNullable<CompilerInstallation["developmentRunners"]>[number];

export function developmentCompilerInstallation(
	moduleDirectory: string,
): CompilerInstallation {
	const sourceDirectory = path.resolve(moduleDirectory);
	return {
		platformSourceRoot: sourceDirectory,
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
	mutableDevelopmentRunnerPath?: string,
	platformSourceRoot?: string,
): CompilerInstallation {
	return {
		runtimeDirectory: path.resolve(runtimeDirectory),
		...(platformSourceRoot === undefined
			? {}
			: { platformSourceRoot: path.resolve(platformSourceRoot) }),
		...(licensePath === undefined ? {} : { licensePath: path.resolve(licensePath) }),
		testModulePath: path.resolve(testModulePath),
		nodeGlobalsPath: path.resolve(
			nodeGlobalsPath ?? path.join(path.dirname(testModulePath), "node-globals.mjs"),
		),
		frontendIdentity: TYPE_STRIPPER_IDENTITY,
		...(developmentRunnerPath === undefined
			? {}
			: {
					developmentRunners: [
						{
							executablePath: path.resolve(developmentRunnerPath),
							inProcess: true,
							wireProtocol: "product" as const,
							primordials: "locked" as const,
							webPlatform: true,
							node: true,
							eval: true,
							realms: true,
							regexp: true,
							temporal: false,
							intl: false,
							externalAssets: true,
						},
						...(mutableDevelopmentRunnerPath === undefined
							? []
							: [
									{
										executablePath: path.resolve(mutableDevelopmentRunnerPath),
										inProcess: false,
										wireProtocol: "wire-list" as const,
										primordials: "mutable" as const,
										webPlatform: true,
										node: true,
										eval: true,
										realms: true,
										regexp: true,
										temporal: false,
										intl: false,
										externalAssets: true,
									},
								]),
					],
				}),
		evalCompiler: { kind: "prebuilt", wirePath: path.resolve(compilerWirePath) },
	};
}

export interface BuildCommandResult {
	applicationImage?: ApplicationImageDescriptor;
	binaryPath?: string;
	serializedPath?: string;
	artifactDirectory?: string;
	runArguments?: Array<string>;
	dependencies?: Array<string>;
	dependencyIdentities?: Array<FrontendDependencyIdentity>;
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
): DevelopmentRunner | undefined {
	return context.installation.developmentRunners?.find(
		(runner) =>
			(Object.keys(config.assets).length === 0 || runner.externalAssets) &&
			config.engine.primordials === runner.primordials &&
			(!config.surface.webPlatform || runner.webPlatform) &&
			(!config.surface.node || runner.node) &&
			(config.engine.eval !== true || runner.eval) &&
			(!config.engine.realms || runner.realms) &&
			(!config.engine.regexp || runner.regexp) &&
			(!config.engine.temporal || runner.temporal) &&
			(!config.engine.intl.enabled || runner.intl),
	);
}

export function applicationDriverPath(
	installation: CompilerInstallation,
	webPlatform: boolean,
	node = false,
	workers = false,
): string {
	return path.join(
		installation.runtimeDirectory,
		webPlatform || node || workers ? "host_main.c" : "test262_main.c",
	);
}

interface PreparedCommand {
	compile(): CompiledBuildFrontend;
	compileAsync(
		compiler: BuildRootCompiler,
		concurrency: number,
	): Promise<CompiledBuildFrontend>;
	finish(frontend: CompiledBuildFrontend): BuildCommandResult;
}

export function prepareCommand(
	command: BuildCommand | RunCommand | DevCommand,
	context: CommandContext,
	compact = false,
): BuildCommandResult {
	const prepared = prepareCommandState(command, context, compact);
	return prepared.finish(prepared.compile());
}

export async function prepareCommandAsync(
	command: BuildCommand,
	context: CommandContext,
): Promise<BuildCommandResult> {
	const requested =
		command.compileConcurrency ?? Math.min(3, context.availableCompileConcurrency ?? 1);
	const fallback =
		context.rootCompiler === undefined
			? "root transport unavailable"
			: context.stripTypes !== stripCompactTypes
				? "custom type stripper"
				: !command.production || command.profile
					? "serial build policy"
					: undefined;
	const concurrency =
		fallback === undefined
			? Math.max(1, Math.min(requested, context.availableCompileConcurrency ?? 1))
			: 1;
	const reason =
		fallback ?? (concurrency < requested ? "available job budget" : undefined);
	if (command.compileConcurrency !== undefined)
		writeStderr(
			`Compile concurrency: ${concurrency} total jobs maximum (${concurrency > 1 ? "parallel roots" : `serial${reason === undefined ? "" : `: ${reason}`}`}; requested ${requested})`,
		);
	const prepared = prepareCommandState(command, context, false, true);
	const frontend =
		concurrency > 1 && context.rootCompiler !== undefined
			? await prepared.compileAsync(context.rootCompiler, concurrency)
			: prepared.compile();
	return prepared.finish(frontend);
}

function prepareCommandState(
	command: BuildCommand | RunCommand | DevCommand,
	context: CommandContext,
	compact = false,
	validateConfiguration = false,
): PreparedCommand {
	const configPath = path.resolve(command.configPath ?? BUILD_CONFIG_NAME);
	const configurationRevision = () => {
		if (!existsSync(configPath)) return undefined;
		const stat = statSync(configPath);
		return JSON.stringify([
			stat.size,
			stat.mtimeMs,
			stat.ctimeMs,
			stat.ino,
			stat.dev,
			readFileSync(configPath, "utf8"),
		]);
	};
	const revision = validateConfiguration ? configurationRevision() : undefined;
	const validateConfig = () => {
		if (validateConfiguration && configurationRevision() !== revision)
			throw new BuildConfigError(
				`configuration changed before build publication: ${configPath}`,
			);
	};
	const buildConfig = loadCommandConfig(command, context.stripTypes);
	validateConfig();
	const entrypointPath = resolveEntrypoint(command, buildConfig);
	const name =
		command.kind === "build"
			? (command.internal.name ?? resolveOutputName(buildConfig))
			: resolveOutputName(buildConfig);
	const verbose = command.kind === "build" ? command.internal.verbose : command.verbose;
	const reporter = new BuildReporter(
		verbose,
		compact && !verbose,
		context.checkpoint,
		context.onCompilationPhase,
	);
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
	const assetIdentities = frontendSession.dependencyIdentities(
		assets.flatMap((asset) => asset.files.map((file) => file.inputPath)),
	);
	const validatePreparedInputs = () => {
		validateConfig();
		if (!validateConfiguration) return;
		for (const identity of assetIdentities) {
			if (!frontendDependencyUnchanged(identity))
				throw new BuildConfigError(
					`asset changed before build publication: ${identity.path}`,
				);
		}
	};
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

	const compiledNativeOutput = command.kind !== "build" || command.internal.compiled;
	const execution = resolveExecution(command, buildConfig, {
		compiled:
			command.kind === "build"
				? command.internal.compiled && command.internal.serializePath === undefined
				: command.profile,
		optimization: production ? "full" : "development",
		target:
			command.kind === "build" && command.target !== undefined
				? executionTarget(command.target)
				: hostExecutionTarget(process.platform, process.arch),
	});
	const compilerDiagnostics = command.kind === "build" && command.internal.dumpCore;
	const compilerPhases: Array<{ phase: string; durationMs: number }> = [];
	const frontendOptions: CompileBuildFrontendOptions = {
		platformSourceRoot:
			context.installation.platformSourceRoot ??
			path.dirname(context.installation.nodeGlobalsPath),
		entrypoint: entrypointPath,
		config: buildConfig,
		execution,
		...(buildConfig.surface.node
			? {
					nodeGlobalsSource: readFileSync(context.installation.nodeGlobalsPath, "utf-8"),
				}
			: {}),
		stripTypes: context.stripTypes,
		stripperIdentity: context.installation.frontendIdentity,
		session: frontendSession,
		optimization: production ? "full" : "development",
		// Debug builds pay per-pass Core verification so a broken transform
		// names its own pass instead of surfacing at a later boundary.
		...(debugEnabled ? { coreVerification: "per-pass" as const } : {}),
		profile: command.profile,
		coreInstrumentation:
			command.kind === "build" ? command.internal.coreReport : undefined,
		enforcePolicies: !(
			command.kind === "build" && command.internal.serializePath !== undefined
		),
		// Profile metadata is derived from the optimized semantic program and is
		// not part of the portable wire schema yet. Do not accept a definition-only
		// frontend cache hit that would discard its source-site identities.
		forceCompile:
			debugEnabled || compilerDiagnostics || command.profile || reporter.verbose,
		relocatable: command.kind !== "build" && !command.profile,
		onCompilePhase: (phase, durationMs) => {
			context.checkpoint?.();
			compilerPhases.push({ phase, durationMs });
		},
		dependencyWorker: context.dependencyWorker,
		afterCoreOptimization: compilerDiagnostics
			? (core) => {
					if (command.kind === "build" && compilerDiagnostics) {
						log.info(formatCoreProgram(core));
					}
				}
			: undefined,
	};
	const normalizeCompileError = (error: unknown): never => {
		if (error instanceof BuildConfigError) commandError(`error: ${error.message}`);
		throw error;
	};
	const compile = () =>
		reporter.phase(
			"Compile modules",
			() => {
				try {
					return compileBuildFrontend(frontendOptions);
				} catch (error) {
					return normalizeCompileError(error);
				}
			},
			(result) => `frontend cache ${result.cache}`,
		);
	const compileAsync = async (compiler: BuildRootCompiler, concurrency: number) =>
		reporter.phaseAsync(
			"Compile modules",
			async () => {
				try {
					return await compileBuildFrontendAsync(frontendOptions, compiler, {
						concurrency,
						signal: context.rootCompilationSignal,
						beforePublication: validatePreparedInputs,
					});
				} catch (error) {
					return normalizeCompileError(error);
				}
			},
			(result) => `frontend cache ${result.cache}`,
		);
	const finish = (frontend: CompiledBuildFrontend): BuildCommandResult => {
		validatePreparedInputs();
		reporter.detail("Frontend cache", `${frontend.cache} (${frontend.frontendMs}ms)`);
		for (const diagnostic of frontend.diagnostics) {
			reporter.warning(
				`${diagnostic.path}:${diagnostic.line}:${diagnostic.column} ` +
					`[${diagnostic.code}] ${diagnostic.message}`,
			);
		}
		reporter.detail(
			frontend.phases.workerOverlap ? "Owner module parses" : "Module parses",
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
				`serialize ${frontend.phases.serializeMs}ms, workers ${frontend.phases.workerMs}ms${frontend.phases.workerOverlap ? " overlapping root window" : ""}`,
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
		if (frontend.optimizationReport !== undefined) {
			for (const { label, value } of formatCoreOptimizationReport(
				frontend.optimizationReport,
			)) {
				reporter.detail(label, value);
			}
		}
		const dependencies = [
			...new Set([
				...frontend.dependencies,
				...assets.flatMap((asset) => asset.files.map((file) => file.inputPath)),
			]),
		].sort();
		const dependencyIdentities = frontendSession.dependencyIdentities(dependencies);
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
			const workerManifest = writeSerializedWorkerManifest(
				frontend.workerImages,
				serializePath,
			);
			if (workerManifest !== undefined)
				reporter.detail("Worker manifest", workerManifest);
			reporter.detail("Serialized bytes", frontend.wire.length);
			reporter.complete("Serialized", serializePath, true);
			return { serializedPath: serializePath, dependencies, dependencyIdentities };
		}

		const packagedRunner =
			command.kind !== "build" && !command.profile
				? compatibleDevelopmentRunner(buildConfig, context)
				: undefined;
		const workerManifest =
			command.kind === "build"
				? undefined
				: cacheDevelopmentWorkerManifest(frontend.workerImages);
		if (command.kind !== "build" && packagedRunner !== undefined) {
			const wirePaths = reporter.phase("Cache development image", () =>
				frontend.runtimeArtifacts.map((artifact) => artifact.path),
			);
			const surfaceMask =
				(buildConfig.surface.webPlatform ? 1 : 0) | (buildConfig.surface.node ? 2 : 0);
			const runArguments = workerManifestArguments(workerManifest).concat(
				packagedRunner.wireProtocol === "product"
					? [
							assetManifest === undefined
								? "--maligator-internal-run-wire"
								: "--maligator-internal-run-wire-assets",
							String(surfaceMask),
							String(wirePaths.length),
							...(assetManifest === undefined ? [] : [assetManifest]),
							entrypointPath,
							...wirePaths,
							...command.programArgs,
						]
					: [
							assetManifest === undefined
								? "--maligator-internal-run-wires"
								: "--maligator-internal-run-wires-assets",
							String(wirePaths.length),
							...(assetManifest === undefined ? [] : [assetManifest]),
							entrypointPath,
							...wirePaths,
							...command.programArgs,
						],
			);
			reporter.detail("Execution backend", "packaged development runtime");
			reporter.detail("Development images", wirePaths.join(", "));
			reporter.complete("Ready", packagedRunner.executablePath, false);
			return {
				...(packagedRunner.inProcess
					? {
							applicationImage: {
								schema: 1 as const,
								wires: frontend.runtimeArtifacts.map((artifact) => ({
									path: artifact.path,
									sha256: artifact.digest,
								})),
								entryPath: entrypointPath,
								...(workerManifest === undefined
									? {}
									: { workerManifestPath: workerManifest }),
								...(assetManifest === undefined
									? {}
									: { assetManifestPath: assetManifest }),
								webPlatform: buildConfig.surface.webPlatform,
								node: buildConfig.surface.node,
								engine: {
									primordials: buildConfig.engine.primordials,
									eval: buildConfig.engine.eval === true,
									realms: buildConfig.engine.realms,
									regexp: buildConfig.engine.regexp,
									temporal: buildConfig.engine.temporal,
									intl: buildConfig.engine.intl.enabled,
								},
							},
						}
					: {}),
				binaryPath: packagedRunner.executablePath,
				runArguments,
				dependencies,
				dependencyIdentities,
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
								intrinsicGlobalReads: true,
								stripTypes: context.stripTypes,
							}),
						bakeProgram: () =>
							compileEntrypoint(evalCompiler.entrypoint, {
								intrinsicGlobalReads: true,
								stripTypes: context.stripTypes,
							}),
					}
				: { kind: "prebuilt" as const, path: evalCompiler.wirePath };
		const baseDerivation = buildDerivationFromConfig(buildConfig);
		const derivation = command.profile
			? {
					features: normalizeNativeFeatures({
						...baseDerivation.features,
						profileEnabled: command.profile,
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
						/^[A-Za-z0-9_./:@%+=,-]+$/.test(argument)
							? argument
							: JSON.stringify(argument),
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
				frontend.runtimeArtifacts.map((artifact) => artifact.path),
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
					...workerManifestArguments(workerManifest),
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
				dependencyIdentities,
			};
		}

		const programImage = frontend.programImage;
		const output = reporter.phase("Generate native code", () => [
			...emitProgramTranslationUnits(programImage, {
				sourcePath: nativeSourcePath,
				compiled: compiledNativeOutput,
				assets,
				maligatorSurface: buildConfig.surface.maligator,
			}),
			...emitWorkerImageTranslationUnits(frontend.workerImages, {
				sourcePath: nativeSourcePath,
				compiled: compiledNativeOutput,
				assets,
				maligatorSurface: buildConfig.surface.maligator,
			}),
		]);
		if (command.kind === "build" && command.internal.emitC)
			log.info(output.map((unit) => unit.source).join("\n"));
		reporter.detail("Translation units", output.length);
		reporter.detail(
			"Generated C bytes",
			output.reduce((total, unit) => total + unit.source.length, 0),
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
					onGeneratedObject: (event) => {
						generatedObjects++;
						if (event.cache === "hit") generatedObjectHits++;
						const largestDefinitions = [...(event.definitions ?? [])]
							.sort((left, right) => right.sourceCodeUnits - left.sourceCodeUnits)
							.slice(0, 3)
							.map(
								(definition) =>
									`${definition.symbol} ${formatCacheBytes(definition.sourceCodeUnits)}`,
							);
						reporter.detail(
							`Generated C object · ${event.generatedKind ?? event.role} · ${event.unit}`,
							[
								`${event.cache} · source ${formatCacheBytes(event.sourceBytes)} · object ${formatCacheBytes(event.objectBytes)}`,
								event.compileDurationMs === null
									? undefined
									: `compile ${event.compileDurationMs.toFixed(1)} ms · CPU ${(
											event.userCpuMs! + event.systemCpuMs!
										).toFixed(1)} ms`,
								event.peakRssBytes === undefined
									? undefined
									: `peak RSS ${formatCacheBytes(event.peakRssBytes)}`,
								event.scheduledCompileDurationMs === undefined
									? undefined
									: `scheduled from ${event.scheduledCompileDurationMs.toFixed(1)} ms estimate`,
								largestDefinitions.length === 0
									? undefined
									: `largest definitions ${largestDefinitions.join(", ")}`,
								event.path,
							]
								.filter((part) => part !== undefined)
								.join(" · "),
						);
					},
					mainFile: applicationDriverPath(
						context.installation,
						buildConfig.surface.webPlatform,
						buildConfig.surface.node,
						frontend.workerImages.length > 0,
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
						{
							coreOptimizationReport: frontend.optimizationReport,
							coreOptimizationPlan: frontend.optimizationPlan,
						},
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
				dependencyIdentities,
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
			dependencyIdentities,
			...(preparedProfile === undefined ? {} : { profile: preparedProfile }),
		};
	};
	return { compile, compileAsync, finish };
}

/** Compile and link one parsed `build` command without owning process dispatch. */
export function buildCommand(
	command: BuildCommand,
	context: CommandContext,
): BuildCommandResult {
	return prepareCommand(command, context);
}

interface ApplicationRunOutcome extends RunOutcome {
	applicationExit?: ApplicationExit;
}

function reportRunOutcome(outcome: ApplicationRunOutcome): void {
	if (outcome.applicationExit?.reason === "error") {
		const error = outcome.applicationExit.error;
		writeStderr(
			`Application error: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (outcome.status === 0) {
		writeStderr("Exited with code 0");
		return;
	}
	writeStderr(
		`Exited with ${outcome.signal ? `signal ${outcome.signal}` : `code ${outcome.status ?? "unknown"}`}`,
	);
}

/** Compile, link, and execute one parsed `run` command. */
export async function runCommand(
	command: RunCommand,
	context: CommandContext,
): Promise<ApplicationRunOutcome> {
	const result =
		context.compiler === undefined
			? prepareCommand(command, context)
			: await context.compiler.prepare(command);
	const binaryPath = result.binaryPath!;
	if (
		!command.profile &&
		result.applicationImage !== undefined &&
		context.applications !== undefined
	) {
		const application = launchApplication(result, command.programArgs, context);
		try {
			await application.evaluated;
			const outcome = await application.closed!;
			reportRunOutcome(outcome);
			return outcome;
		} finally {
			await application.stop();
		}
	}
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
					{ workloadSucceeded: outcome.status === 0 && outcome.signal === undefined },
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
	reportRunOutcome(outcome);
	return outcome;
}

interface LaunchedApplication {
	backend: "thread" | "process";
	evaluated: Promise<void>;
	applicationReady?: Promise<void>;
	closed?: Promise<ApplicationRunOutcome>;
	exit?(): ApplicationExit | undefined;
	status(): number | undefined;
	stop(): Promise<void>;
}

function launchApplication(
	build: BuildCommandResult,
	programArgs: Array<string>,
	context: CommandContext,
	environment?: NodeJS.ProcessEnv,
): LaunchedApplication {
	if (
		build.profile === undefined &&
		build.applicationImage !== undefined &&
		context.applications !== undefined
	) {
		const image = context.applications.load(build.applicationImage);
		try {
			const instance = image.launch({
				argv: [
					build.binaryPath ?? process.execPath,
					build.applicationImage.entryPath,
					...programArgs,
				],
				name: build.applicationImage.entryPath,
			});
			void instance.applicationReady.catch(() => {});
			let status: number | undefined;
			let applicationExit: ApplicationExit | undefined;
			const closed = instance.closed.then((exit) => {
				status = exit.code;
				applicationExit = exit;
				return { status: exit.code, applicationExit: exit };
			});
			void closed.catch(() => {});
			let stopping: Promise<void> | undefined;
			return {
				backend: "thread",
				evaluated: instance.ready,
				applicationReady: instance.applicationReady,
				closed,
				status: () => status,
				exit: () => applicationExit,
				stop() {
					return (stopping ??= (async () => {
						const failures: Array<unknown> = [];
						try {
							await instance.terminate();
						} catch (error) {
							failures.push(error);
						}
						try {
							await closed;
						} catch (error) {
							failures.push(error);
						}
						try {
							image.close();
						} catch (error) {
							failures.push(error);
						}
						if (failures.length === 1) throw failures[0];
						if (failures.length > 1)
							throw new AggregateError(failures, "application shutdown failed");
					})());
				},
			};
		} catch (error) {
			image.close();
			throw error;
		}
	}
	const host = context.developmentProcesses;
	if (host === undefined)
		commandError(
			"error: this Maligator installation does not provide application processes",
		);
	const handle = host.spawn(
		build.binaryPath!,
		build.runArguments ?? programArgs,
		environment,
	);
	let stopping: Promise<void> | undefined;
	return {
		backend: "process",
		evaluated: Promise.resolve(),
		status: () => host.status(handle),
		stop() {
			return (stopping ??=
				host.status(handle) === undefined
					? stopDevelopmentProcess(host, handle)
					: Promise.resolve());
		},
	};
}

async function awaitApplicationEvaluation(
	application: LaunchedApplication,
	signal: AbortSignal,
): Promise<void> {
	let abort!: () => void;
	const canceled = new Promise<never>((_resolve, reject) => {
		abort = () =>
			reject(
				signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)),
			);
		signal.addEventListener("abort", abort, { once: true });
	});
	try {
		signal.throwIfAborted();
		await Promise.race([application.evaluated, canceled]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}

interface WatchedFileState {
	file: string;
	identity: string | undefined;
	external: boolean;
}

function watchIdentity(file: string): string | undefined {
	try {
		const stats = statSync(file);
		return stats.isFile()
			? `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.ino}:${stats.dev}`
			: undefined;
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
	files.add(configPath);
	if (command.entry !== undefined) files.add(path.resolve(command.entry));
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
	if (processHost === undefined && context.applications === undefined) {
		commandError("error: this Maligator installation does not provide application hosts");
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
	let initialDependencies: Array<string> = [];
	if (command.entry === undefined) {
		try {
			initialDependencies = [
				resolveEntrypoint(command, loadCommandConfig(command, context.stripTypes)),
			];
		} catch {
			initialDependencies = [];
		}
	}
	let states = watchedFiles(command, initialDependencies);
	const watchHost = context.developmentWatcher;
	const watchHandle = watchHost?.create(states.map((state) => state.file));
	const shutdown = new AbortController();
	const restorations = new Set<Promise<void>>();
	const restorationFailures: Array<unknown> = [];
	let child: LaunchedApplication | undefined;
	let childGeneration = 0;
	let activeBuild: BuildCommandResult | undefined;
	let activeGeneration = 0;
	const spawnApplication = (build: BuildCommandResult, generation: number) => {
		activeProfile = nextProfile(build);
		const launched = launchApplication(
			build,
			command.programArgs,
			context,
			activeProfile === undefined
				? undefined
				: {
						...activeProfile.environment,
						...compilerProfileRuntimeEnvironment(command),
					},
		);
		child = launched;
		childGeneration = generation;
		development.observeApplication({
			generation,
			backend: launched.backend,
			state: "started",
		});
		if (launched.applicationReady !== undefined)
			void Promise.all([launched.evaluated, launched.applicationReady])
				.then(() => {
					if (child === launched && !stopping) {
						development.observeApplication({
							generation,
							backend: launched.backend,
							state: "ready",
						});
					}
				})
				.catch(() => {});
		return launched;
	};
	const stopApplication = async (current = child) => {
		if (current === undefined) return;
		const generation = childGeneration;
		await current.stop();
		if (child !== current) return;
		const exit = current.exit?.();
		development.observeApplication({
			generation,
			backend: current.backend,
			state: "closed",
			...(current.status() === undefined ? {} : { exitCode: current.status() }),
			...(exit === undefined
				? {}
				: {
						reason: exit.reason,
						...(exit.reason === "error" ? { error: String(exit.error) } : {}),
					}),
		});
		child = undefined;
		finalizeActiveProfile();
	};
	const restoreActiveApplication = () => {
		if (!stopping && activeBuild !== undefined) {
			const generation = activeGeneration;
			const restored = spawnApplication(activeBuild, activeGeneration);
			const task = awaitApplicationEvaluation(restored, shutdown.signal)
				.then(() => {
					if (child !== restored || stopping) return;
					if (
						restored.backend === "thread" &&
						development.snapshot().application?.state !== "ready"
					)
						development.observeApplication({
							generation,
							backend: restored.backend,
							state: "evaluated",
						});
				})
				.catch(async (error: unknown) => {
					if (child !== restored || stopping) return;
					try {
						writeStderr(
							`Application restoration failed for generation ${generation}: ${error instanceof Error ? error.message : String(error)}`,
						);
					} catch (reportError) {
						restorationFailures.push(
							new AggregateError(
								[error, reportError],
								`application restoration error could not be reported for generation ${generation}`,
							),
						);
					}
					try {
						await stopApplication(restored);
					} catch (cleanupError) {
						restorationFailures.push(
							new AggregateError(
								[error, cleanupError],
								`application restoration cleanup failed for generation ${generation}`,
							),
						);
					}
				})
				.finally(() => {
					restorations.delete(task);
				});
			restorations.add(task);
		}
	};
	const compiler: Pick<CompilerService, "prepare"> = context.compiler ?? {
		prepare(_command, options = {}) {
			for (const file of options.invalidatedPaths ?? []) session.invalidate(file);
			if (options.invalidateAll) session.invalidate();
			options.signal?.throwIfAborted();
			return Promise.resolve(prepareCommand(command, retainedContext, true));
		},
	};
	let buildStartedAt = initialBuildStartedAt;
	const development = createDevelopmentSession(command, compiler, {
		async publish(build, generation, isCurrent, signal) {
			if (!isCurrent()) return false;
			const validate = () => [
				...new Set([
					...changedFiles(states, true),
					...(build.dependencyIdentities ?? [])
						.filter((identity) => !frontendDependencyUnchanged(identity))
						.map((identity) => identity.path),
				]),
			];
			let changed = validate();
			if (changed.length > 0) {
				queueChanges(changed);
				return false;
			}
			const previousStates = new Map(states.map((state) => [state.file, state]));
			const identities = new Map(
				(build.dependencyIdentities ?? []).map((identity) => [identity.path, identity]),
			);
			states = watchedFiles(command, [
				...previousStates.keys(),
				...(build.dependencies ?? []),
			]).map((state) => {
				const identity = identities.get(state.file);
				return identity === undefined
					? (previousStates.get(state.file) ?? state)
					: {
							...state,
							identity: `${identity.size}:${identity.mtimeMs}:${identity.ctimeMs}:${identity.ino}:${identity.dev}`,
						};
			});
			watchHost?.update(
				watchHandle,
				states.map((state) => state.file),
			);
			if (child !== undefined) {
				await stopApplication();
			}
			changed = validate();
			if (changed.length > 0 && isCurrent()) queueChanges(changed);
			if (!isCurrent() || changed.length > 0) {
				restoreActiveApplication();
				return false;
			}
			let launched: LaunchedApplication | undefined;
			try {
				launched = spawnApplication(build, generation);
				await awaitApplicationEvaluation(launched, signal);
			} catch (error) {
				if (launched !== undefined) await stopApplication();
				restoreActiveApplication();
				if (!isCurrent()) return false;
				throw error;
			}
			changed = validate();
			if (changed.length > 0 && isCurrent()) queueChanges(changed);
			if (!isCurrent() || changed.length > 0) {
				await stopApplication();
				restoreActiveApplication();
				return false;
			}
			if (
				launched.backend === "thread" &&
				development.snapshot().application?.state !== "ready"
			)
				development.observeApplication({
					generation,
					backend: launched.backend,
					state: "evaluated",
				});
			writeStderr(
				activeBuild === undefined
					? `${launched.backend === "thread" ? "Evaluated" : "Started"} in ${formatDevelopmentDuration(Date.now() - initialBuildStartedAt)} · watching ${states.length} files · press Ctrl+C to stop`
					: `Compiled in ${formatDevelopmentDuration(Date.now() - buildStartedAt)} · restarted`,
			);
			activeBuild = build;
			activeGeneration = generation;
			return true;
		},
		failed(error) {
			writeStderr(
				`Rebuild failed: ${error instanceof Error ? error.message : String(error)}${
					child === undefined
						? "; waiting for changes"
						: "; last successful application is still running"
				}`,
			);
		},
		async stop() {
			const failures: Array<unknown> = [];
			try {
				await stopApplication();
			} catch (error) {
				failures.push(error);
			}
			await Promise.all(restorations);
			try {
				finalizeActiveProfile();
			} catch (error) {
				failures.push(error);
			}
			failures.push(...restorationFailures);
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1)
				throw new AggregateError(failures, "development application cleanup failed");
		},
		event(event) {
			if (
				event.application === undefined &&
				event.compilation === undefined &&
				event.phase === "running"
			)
				buildStartedAt = event.at;
			if (command.status) {
				const resources = context.applications?.resources?.();
				writeStderr(
					`Session ${JSON.stringify({ ...development.snapshot(), ...(resources === undefined ? {} : { resources }) })}`,
				);
			}
			if (command.verbose) {
				if (event.compilation !== undefined) {
					writeStderr(
						`Generation ${event.generation}: ${event.compilation.label} ${event.compilation.state}`,
					);
					return;
				}
				writeStderr(
					`Generation ${event.generation}: ${event.application === undefined ? event.phase : `${event.application.backend} ${event.application.state}`}`,
				);
			}
		},
	});
	let stopping = false;
	const stop = () => {
		stopping = true;
		shutdown.abort();
		void development.close().catch(() => {});
	};
	function queueChanges(changedPaths: Array<string>): void {
		writeStderr(
			`Changed ${changedPaths.map((file) => path.relative(process.cwd(), file)).join(", ")}`,
		);
		const changed = new Set(changedPaths);
		const previous = new Map(states.map((state) => [state.file, state]));
		states = watchedFiles(command, [...previous.keys(), ...changedPaths]).map((state) =>
			changed.has(state.file) ? state : (previous.get(state.file) ?? state),
		);
		watchHost?.update(
			watchHandle,
			states.map((state) => state.file),
		);
		development.request(
			changedPaths,
			changedPaths.includes(path.resolve(command.configPath ?? BUILD_CONFIG_NAME)),
		);
	}
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	let poll = 0;
	let loopFailure: { error: unknown } | undefined;
	const failures: Array<unknown> = [];
	try {
		development.request();
		if (command.verbose) {
			writeStderr(
				`Watcher: ${watchHost === undefined ? "polling fallback" : "filesystem events"}`,
			);
		}
		while (!stopping) {
			if (watchHost === undefined) await delay(75);
			else await watchHost.wait(watchHandle, 50);
			if (stopping) break;
			const changed = changedFiles(states, watchHost !== undefined || poll++ % 14 === 0);
			if (changed.length === 0) {
				const current = child;
				const status = current?.status();
				if (current !== undefined && status !== undefined) {
					writeStderr(
						`Application ${status === 0 ? "stopped" : "crashed"} with code ${status}; waiting for changes.`,
					);
					const exit = current.exit?.();
					if (exit?.reason === "error")
						reportRunOutcome({ status, applicationExit: exit });
					await stopApplication(current);
				}
				continue;
			}

			queueChanges(changed);
		}
	} catch (error) {
		loopFailure = { error };
	} finally {
		stopping = true;
		shutdown.abort();
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
		if (loopFailure !== undefined) failures.push(loopFailure.error);
		try {
			watchHost?.close(watchHandle);
		} catch (error) {
			failures.push(error);
		}
		try {
			await development.close();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1)
		throw new AggregateError(failures, "development shutdown failed");
}

const PROFILED_TEST_RESULT_PREFIX = "__MALIGATOR_TEST_RESULT__";

function buildIsolatedTestRunner(
	context: CommandContext,
	config: ResolvedBuildConfig,
): string {
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
							intrinsicGlobalReads: true,
							stripTypes: context.stripTypes,
						}),
					bakeProgram: () =>
						compileEntrypoint(evalCompiler.entrypoint, {
							intrinsicGlobalReads: true,
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
	return buildDevelopmentRunner(nativeContext, false, derivation.cacheSuffix).binaryPath;
}

function executeIsolatedTests(
	command: TestCommand,
	context: CommandContext,
	config: ResolvedBuildConfig,
	packagedRunner?: DevelopmentRunner,
): TestCommandSummary {
	const compiled = prepareIsolatedTestCommand(command, context, config);
	const runner =
		packagedRunner?.executablePath ?? buildIsolatedTestRunner(context, config);
	const wirePaths =
		"wires" in compiled
			? compiled.wires.map((wire) => wire.path)
			: [cacheFrontendWire(compiled.wire)];
	const assets = includeConfiguredAssets(config.assets, process.cwd(), {
		cacheDirectory: maligatorCacheDirectory(),
		session: new FrontendCompilationSession(),
	});
	const assetManifest = cacheDevelopmentAssets(assets);
	const entrypoint = compiled.files[0]!;
	const workerManifest = cacheDevelopmentWorkerManifest(
		"workerImages" in compiled ? compiled.workerImages : [],
	);
	const args = [
		...workerManifestArguments(workerManifest),
		assetManifest === undefined
			? "--maligator-internal-run-wires"
			: "--maligator-internal-run-wires-assets",
		String(wirePaths.length),
		...(assetManifest === undefined ? [] : [assetManifest]),
		entrypoint,
		...wirePaths,
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
		cacheHits: compiled.cache === "hit" ? 1 : 0,
		cacheMisses: compiled.cache === "miss" ? 1 : 0,
		artifactHits: "artifactHits" in compiled ? compiled.artifactHits : 0,
		artifactMisses: "artifactMisses" in compiled ? compiled.artifactMisses : 0,
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
							intrinsicGlobalReads: true,
							stripTypes: context.stripTypes,
						}),
					bakeProgram: () =>
						compileEntrypoint(evalCompiler.entrypoint, {
							intrinsicGlobalReads: true,
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
	const emitOptions = {
		sourcePath: nativeSourcePath,
		compiled: true,
		assets,
		maligatorSurface: config.surface.maligator,
	};
	const source = [
		...emitProgramTranslationUnits(compiled.programImage, emitOptions),
		...emitWorkerImageTranslationUnits(compiled.workerImages, emitOptions),
	];
	const binary = buildLocalBinary({
		context: nativeContext,
		name: "maligator-profile-test",
		cSource: source,
		verbose: false,
		mainFile: applicationDriverPath(
			context.installation,
			config.surface.webPlatform,
			config.surface.node,
			compiled.workerImages.length > 0,
		),
		cacheSuffix: derivation.cacheSuffix,
	}).binaryPath;
	const profile = prepareProfile(
		binary,
		compiled.programImage,
		command.profileCompiler === true ? "compiler" : "sampling",
		{
			coreOptimizationReport: compiled.optimizationReport,
			coreOptimizationPlan: compiled.optimizationPlan,
		},
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
		const finalized = finalizeProfileCapture(capture.directory, profile, "test", {
			workloadSucceeded: testResult.failed === 0,
		});
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
	let exitCode: number | undefined;
	let exitSignal: NodeJS.Signals | undefined;
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
			if (report.toolchain === undefined) exitCode = 1;
			return;
		}
		if (command.kind === "cache") {
			runCacheCommand(command);
			return;
		}
		if (command.kind === "build") {
			if (!command.production && context.compiler !== undefined) {
				await context.compiler.prepare(command);
			} else if (command.production) {
				await prepareCommandAsync(command, context);
			} else buildCommand(command, context);
		} else if (command.kind === "run") {
			const outcome = await runCommand(command, context);
			if (outcome.status !== 0) exitCode = outcome.status ?? 1;
			exitSignal = outcome.signal;
		} else if (command.kind === "dev") {
			await devCommand(command, context);
		} else {
			let result: Awaited<ReturnType<typeof executeTestCommand>>;
			try {
				if (command.watch) {
					if (context.applications === undefined) {
						commandError(
							"error: test --watch requires a compatible native application host",
						);
					}
					const watchConfig = () => {
						const current = loadCommandConfig(command, context.stripTypes);
						if (
							compatibleDevelopmentRunner(current, context)?.inProcess !== true ||
							context.applications === undefined
						) {
							commandError(
								"error: test --watch requires a compatible native application host",
							);
						}
						return current;
					};
					await watchTestCommand(command, context, watchConfig);
					return;
				}
				const config = loadCommandConfig(command, context.stripTypes);
				const developmentRunner = compatibleDevelopmentRunner(config, context);
				if (
					!command.profile &&
					developmentRunner?.inProcess !== true &&
					(command.isolation !== undefined ||
						(command.executionConcurrency ?? 1) > 1 ||
						command.compileConcurrency > 1)
				) {
					commandError(
						"error: this runtime policy requires a shared test subprocess; isolated or concurrent test sessions are unavailable",
					);
				}
				result = command.profile
					? executeProfiledTests(command, context, config)
					: developmentRunner?.inProcess === true
						? await executeTestCommand(command, context, config)
						: executeIsolatedTests(command, context, config, developmentRunner);
			} catch (error) {
				commandError(`error: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (result.exitCode !== 0) exitCode = result.exitCode;
		}
	} catch (error) {
		if (error instanceof CliUsageError) {
			writeStderr(`error: ${error.message}`);
			writeStderr("Run 'maligator --help' for usage.");
			exitCode = 2;
		} else if (error instanceof CommandError) {
			writeStderr(error.message);
			exitCode = error.exitCode;
		} else if (error instanceof MaligatorCacheRootError) {
			writeStderr(`error: ${error.message}`);
			exitCode = 1;
		} else {
			if (verbose && error instanceof Error && error.stack !== undefined) {
				writeStderr(error.stack);
			} else {
				writeStderr(`error: ${error instanceof Error ? error.message : String(error)}`);
				writeStderr("Run again with '--verbose' for diagnostic details.");
			}
			exitCode = 1;
		}
	} finally {
		try {
			await context.compiler?.close();
		} finally {
			cacheLease?.release();
		}
		if (exitSignal !== undefined) process.kill(process.pid, exitSignal);
		if (exitCode !== undefined) process.exit(exitCode);
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
