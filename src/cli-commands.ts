import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	readSync,
	statSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ApplicationExit,
	ApplicationImageDescriptor,
	ApplicationImageHost,
} from "./application-images.ts";
import { artifactDigest, artifactIdentity } from "./artifact-store.ts";
import { CommandProducers, producerTasks, runBuildProducers } from "./asset-producers.ts";
import {
	collectEmbeddedAssets,
	embedDeclarationsOf,
	embedDeclarationsOfWires,
} from "./assets.ts";
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
	cacheBudget,
	clearAllMaligatorCaches,
	createCacheLease,
	DEFAULT_CACHE_MIN_AGE_MS,
	formatCacheBytes,
	inspectMaligatorCache,
	maintainMaligatorCache,
	pruneMaligatorCache,
	readCacheUsage,
	volumeFreeBytes,
} from "./cache-management.ts";
import { maligatorCacheDirectory, MaligatorCacheRootError } from "./cache-root.ts";
import { BUILD_CONFIG_NAME, initProject } from "./cli-init.ts";
import { executeBinary, executeBinaryReported } from "./cli-run.ts";
import type { RunOutcome } from "./cli-run.ts";
import { CliUsageError, MALIGATOR_VERSION, formatCliHelp, parseCliArgs } from "./cli.ts";
import type {
	BuildCommand,
	CacheCommand,
	DevCommand,
	FfiCommand,
	RunCommand,
	TestCommand,
} from "./cli.ts";
import { CommandProgress, formatCommandDuration } from "./command-progress.ts";
import type { CompilationPhase, CompilerService } from "./compiler-service.ts";
import { formatCoreProgram } from "./compiler/core/core-ir.ts";
import { formatCoreOptimizationReport } from "./compiler/core/core-optimization-report.ts";
import {
	TYPE_STRIPPER_IDENTITY,
	stripCompactTypes,
} from "./compiler/frontend/compact-type-strip.ts";
import type { EmbedDeclaration } from "./compiler/frontend/embed-declarations.ts";
import {
	imageNeedsHostEventLoop,
	imageUsesHost,
} from "./compiler/frontend/host-modules.ts";
import {
	formatSyntaxDiagnostic,
	SyntaxDiagnostic,
} from "./compiler/frontend/syntax-diagnostic.ts";
import {
	compileEntrypoint,
	compileEntrypointToBuffer,
} from "./compiler/pipeline/compile-program.ts";
import { embeddedCompilerOptions } from "./compiler/pipeline/embedded-compiler-options.ts";
import { emitProgramTranslationUnits } from "./compiler/target/emit-program-image.ts";
import { emitWorkerImageTranslationUnits } from "./compiler/target/emit-worker-images.ts";
import { compileDependencyFragmentRequest } from "./dependency-fragment-cache.ts";
import type { DependencyFragmentWorker } from "./dependency-fragment-cache.ts";
import {
	DEVELOPMENT_FRAGMENT_MAIN,
	developmentFragmentUnits,
} from "./development-fragments.ts";
import { createDevelopmentSession } from "./development-session.ts";
import { checkLibraries, formatFfiCheck } from "./ffi/check.ts";
import { declarationsCurrent, generateDeclarations } from "./ffi/declarations.ts";
import {
	buildDevelopmentShims,
	developmentShimArguments,
} from "./ffi/development-shim.ts";
import { FfiError, FfiSourceChangedError } from "./ffi/ffi-error.ts";
import { formatInspection, inspectBindings } from "./ffi/inspect.ts";
import { ffiJsonChunks } from "./ffi/json.ts";
import { nativeLibraryInputs, prepareLibraries, prepareLibrary } from "./ffi/library.ts";
import type { LibraryPreparation, PreparedLibraries } from "./ffi/library.ts";
import { runFfiProbe } from "./ffi/probe.ts";
import {
	cacheFrontendWire,
	FrontendCompilationSession,
	revalidateFrontendDependency,
} from "./frontend-cache.ts";
import type { FrontendDependencyIdentity } from "./frontend-cache.ts";
import { writeSourceChunks } from "./generated-source.ts";
import {
	buildDevelopmentRunner,
	buildLocalBinary,
	buildSharedDevelopmentRunner,
	localDevelopmentRunnerKey,
	packagedDevelopmentRunner,
	prepareCachedGeneratedSources,
	prepareGeneratedSources,
} from "./local-build.ts";
import {
	nativeToolchainOptions,
	resolveNativeBuildContext,
} from "./native-build-context.ts";
import { nativeBuildJobs } from "./native-command.ts";
import { imageUsesUrlParser } from "./native-host-components.ts";
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
import type { TestApplicationHost } from "./testing/application-host.ts";
import {
	executeTestCommand,
	ISOLATED_TEST_RESULT_PREFIX,
	prepareIsolatedTestCommand,
	prepareProfiledTestCommand,
	reportIsolatedTestResult,
	reportProfiledTestResult,
} from "./testing/command.ts";
import type {
	IsolatedTestExecutionOptions,
	TestCommandSummary,
} from "./testing/command.ts";
import { LinkedTestHostSession } from "./testing/linked-host-session.ts";
import type { PreparedLinkedTestHost } from "./testing/linked-host-session.ts";
import type { TestRunResult } from "./testing/protocol.ts";
import { TestSourceChangedError } from "./testing/session.ts";
import type { TestGenerationControls } from "./testing/session.ts";
import { compileTestRuntimeRequest } from "./testing/test-images.ts";
import { watchTestCommand } from "./testing/watch.ts";
import {
	formatToolchainReport,
	formatToolCommand,
	inspectToolchain,
	requireDevelopmentShimCompiler,
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
	testApplications?: TestApplicationHost;
	onFfiDependencies?: (paths: ReadonlyArray<string>) => void;
	checkpoint?: () => void;
	onCompilationPhase?: (event: CompilationPhase) => void;
}

function declarationFileHeader(file: string): string {
	const descriptor = openSync(file, "r");
	try {
		const buffer = Buffer.alloc(1024);
		const length = readSync(descriptor, buffer, 0, buffer.length, 0);
		return buffer.toString("utf8", 0, length);
	} finally {
		closeSync(descriptor);
	}
}

export interface DevelopmentWatchHost {
	create(files: Array<string>, directories: Array<string>): unknown;
	update(handle: unknown, files: Array<string>, directories: Array<string>): void;
	wait(handle: unknown, timeoutMs: number): Promise<void>;
	close(handle: unknown): void;
}

interface DevelopmentBuildCache {
	toolchains: Map<string, { toolchain: Toolchain; plan: NativeBuildPlan }>;
	runners: Map<string, string>;
	/** The previous build's compiler warnings for each entrypoint. */
	warnings: Map<string, ReadonlySet<string>>;
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
	/** Maligator's license and third-party notices, copied into deployable artifacts. */
	licensePaths?: Array<string>;
	/** Source implementation supplied for the virtual maligator:test module. */
	testModulePath: string;
	testHostModulePath?: string;
	/** Cache identity of the active TypeScript erasure frontend. */
	frontendIdentity: string;
	/** Prebuilt executables capable of running compile-time-specialized wire images. */
	developmentRunners?: Array<{
		executablePath: string;
		inProcess: boolean;
		primordials: "locked" | "mutable";
		eval: boolean;
		realms: boolean;
		regexp: boolean;
		temporal: boolean;
		intl: boolean;
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
		licensePaths: [
			path.resolve(sourceDirectory, "../LICENSE"),
			path.resolve(sourceDirectory, "../THIRD_PARTY_NOTICES.md"),
		],
		testModulePath: path.join(sourceDirectory, "testing/runtime.mjs"),
		testHostModulePath: path.join(sourceDirectory, "testing/host-driver.mts"),
		frontendIdentity: TYPE_STRIPPER_IDENTITY,
		evalCompiler: {
			kind: "source",
			sourceDirectory,
			entrypoint: path.join(sourceDirectory, "compiler/pipeline/eval-compiler-entry.mts"),
		},
	};
}

type InstallationPath = string | (() => string);

function deferredInstallationPath(source: InstallationPath): () => string {
	if (typeof source === "string") {
		const resolved = path.resolve(source);
		return () => resolved;
	}
	let resolved: string | undefined;
	return () => (resolved ??= path.resolve(source()));
}

export function productCompilerInstallation(
	runtimeDirectory: InstallationPath,
	compilerWirePath: InstallationPath,
	testModulePath: InstallationPath,
	licensePaths?: Array<InstallationPath>,
	developmentRunnerPath?: string,
	platformSourceRoot?: InstallationPath,
	testHostModulePath?: InstallationPath,
): CompilerInstallation {
	const runtimePath = deferredInstallationPath(runtimeDirectory);
	const compilerPath = deferredInstallationPath(compilerWirePath);
	const testPath = deferredInstallationPath(testModulePath);
	const testHostPath =
		testHostModulePath === undefined
			? undefined
			: deferredInstallationPath(testHostModulePath);
	const platformPath = deferredInstallationPath(
		platformSourceRoot ?? (() => path.dirname(testPath())),
	);
	const licenses = licensePaths?.map(deferredInstallationPath);
	return {
		get runtimeDirectory() {
			return runtimePath();
		},
		get platformSourceRoot() {
			return platformPath();
		},
		get licensePaths() {
			return licenses?.map((read) => read());
		},
		get testModulePath() {
			return testPath();
		},
		get testHostModulePath() {
			return testHostPath?.();
		},
		frontendIdentity: TYPE_STRIPPER_IDENTITY,
		...(developmentRunnerPath === undefined
			? {}
			: {
					developmentRunners: [
						{
							executablePath: path.resolve(developmentRunnerPath),
							inProcess: true,
							primordials: "locked" as const,
							eval: true,
							realms: true,
							regexp: true,
							temporal: false,
							intl: false,
						},
					],
				}),
		evalCompiler: {
			kind: "prebuilt",
			get wirePath() {
				return compilerPath();
			},
		},
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
	/** The `maligator:assets` declarations the prepared images reach. */
	embedDeclarations?: Array<EmbedDeclaration>;
	profile?: PreparedProfile;
}

class CommandError extends Error {
	exitCode: number;

	constructor(message: string, exitCode = 1) {
		super(message);
		Object.defineProperty(this, "name", {
			value: "CommandError",
			configurable: true,
		});
		this.exitCode = exitCode;
	}
}

function commandError(message: string, exitCode = 1): never {
	throw new CommandError(message, exitCode);
}

function writeStderr(message: string): void {
	process.stderr.write(`${message}\n`);
}

function renderSyntaxDiagnostic(error: SyntaxDiagnostic): string {
	return formatSyntaxDiagnostic(
		error,
		process.stderr.isTTY === true && process.env.NO_COLOR === undefined,
	);
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

function selectToolchain(
	command: BuildCommand | RunCommand | DevCommand,
	context: CommandContext,
): { toolchain?: Toolchain; plan?: NativeBuildPlan } {
	if (command.kind === "build" && command.internal.serializePath !== undefined) return {};
	const selectionKey = JSON.stringify({
		target: command.kind === "build" ? command.target : undefined,
		production: command.profile || (command.kind === "build" && command.production),
	});
	const retained = context.developmentCache?.toolchains.get(selectionKey);
	if (retained !== undefined) return retained;
	try {
		const runtimeDirectory = context.installation.runtimeDirectory;
		const toolchain = requireToolchain(
			nativeToolchainOptions(
				runtimeDirectory,
				{ target: command.kind === "build" ? command.target : undefined },
				command.kind === "build" && command.production ? "install" : undefined,
			),
		);
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

type LibraryTools = Pick<
	LibraryPreparation,
	"compiler" | "environment" | "platform" | "cross"
>;

function libraryBuildTools(
	toolchain: Toolchain,
	environment: NodeJS.ProcessEnv = process.env,
): LibraryTools {
	return {
		compiler: toolchain.tools.cc,
		environment: { ...environment, ...toolchain.environmentOverrides },
		platform: toolchain.platform ?? process.platform,
		cross: toolchain.cross === true,
	};
}

function developmentShimTools(environment: NodeJS.ProcessEnv): LibraryTools {
	try {
		return {
			compiler: requireDevelopmentShimCompiler(environment),
			environment,
			platform: process.platform,
			cross: false,
		};
	} catch (error) {
		commandError(`error: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Read the headers of every C library the config declares, or undefined for none. */
function prepareConfiguredLibraries(
	config: ResolvedBuildConfig,
	context: CommandContext,
	tools: LibraryTools,
): PreparedLibraries | undefined {
	if (Object.keys(config.ffi).length === 0) return undefined;
	try {
		return prepareLibraries(config, {
			projectRoot: process.cwd(),
			stripTypes: context.stripTypes,
			...tools,
			onDependencies: context.onFfiDependencies,
		});
	} catch (error) {
		if (context.onFfiDependencies !== undefined && error instanceof FfiSourceChangedError)
			throw new TestSourceChangedError(error.paths);
		if (error instanceof BuildConfigError || error instanceof FfiError) {
			commandError(`error: ${error.message}`);
		}
		throw error;
	}
}

function compatibleDevelopmentRunner(
	config: ResolvedBuildConfig,
	context: CommandContext,
): DevelopmentRunner | undefined {
	// Prebuilt runners cannot contain a project's C library bindings.
	if (Object.keys(config.ffi).length > 0) return undefined;
	return context.installation.developmentRunners?.find(
		(runner) =>
			config.engine.primordials === runner.primordials &&
			(config.engine.eval !== true || runner.eval) &&
			(!config.engine.realms || runner.realms) &&
			(!config.engine.regexp || runner.regexp) &&
			(!config.engine.temporal || runner.temporal) &&
			(!config.engine.intl.enabled || runner.intl),
	);
}

function prepareDevelopmentShims(
	libraries: PreparedLibraries,
	tools: LibraryTools,
	runtimeDirectory: string,
) {
	return buildDevelopmentShims(libraries.libraries, {
		...tools,
		runtimeDirectory,
		cacheDirectory: maligatorCacheDirectory(undefined, tools.environment),
	});
}

/** A program that applies the host personality or starts workers runs the event loop. */
export function applicationDriverPath(
	installation: CompilerInstallation,
	usesHost: boolean,
	workers = false,
): string {
	return path.join(
		installation.runtimeDirectory,
		usesHost || workers ? "host_main.c" : "test262_main.c",
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
	if (
		command.kind === "build" &&
		command.internal.serializePath !== undefined &&
		Object.keys(buildConfig.ffi).length > 0
	) {
		commandError("error: C libraries are not supported by portable wire output");
	}
	const frontendSession = context.frontendSession ?? new FrontendCompilationSession();
	frontendSession.useCacheDirectory();
	const validatePreparedInputs = () => validateConfig();
	const interpreted = command.kind !== "build" && !command.profile;
	const baseDerivation = buildDerivationFromConfig(buildConfig);
	const embeddedRunner = interpreted
		? compatibleDevelopmentRunner(buildConfig, context)
		: undefined;
	const packagedRunner =
		interpreted && embeddedRunner === undefined
			? packagedDevelopmentRunner(
					context.installation.runtimeDirectory,
					baseDerivation.features,
					process.env,
				)
			: undefined;
	const resolveLocalTools = () => {
		const selection = reporter.phase(
			"Resolve toolchain",
			() => selectToolchain(command, context),
			({ toolchain }) =>
				toolchain === undefined
					? undefined
					: `toolchain cache ${toolchain.cacheHit ? "hit" : "miss"}`,
		);
		const { toolchain, plan } = selection;
		if (toolchain !== undefined) {
			reporter.detail("Target", toolchain.target);
			reporter.detail(
				"C compiler",
				`${formatToolCommand(toolchain.tools.cc)} (${toolchain.tools.cc.version})`,
			);
			const rustc = toolchain.tools.rustc;
			reporter.detail(
				"Rust compiler",
				rustc === undefined
					? "using packaged archives"
					: `${formatToolCommand(rustc)} (${rustc.version})`,
			);
		}
		for (const warning of plan?.warnings ?? []) reporter.warning(warning);
		return selection;
	};
	let { toolchain, plan } =
		embeddedRunner === undefined && packagedRunner === undefined
			? resolveLocalTools()
			: {};
	const libraryTools =
		Object.keys(buildConfig.ffi).length === 0
			? undefined
			: toolchain === undefined
				? developmentShimTools(process.env)
				: libraryBuildTools(toolchain);
	const libraries =
		libraryTools === undefined
			? undefined
			: reporter.phase("Prepare C libraries", () =>
					prepareConfiguredLibraries(buildConfig, context, libraryTools),
				);
	// Watched like sources, so editing a contract, header, or library source rebuilds.
	for (const file of libraries?.dependencies ?? []) frontendSession.snapshot(file);
	for (const entry of libraries?.libraries ?? []) {
		reporter.detail(
			`C library ${entry.contract.name}`,
			`${entry.library.method}, ${entry.library.link} link, ${entry.plan.functions.length} functions, ${entry.plan.constants.length} constants`,
		);
	}
	if (
		libraries !== undefined &&
		existsSync(FFI_DECLARATIONS_NAME) &&
		!declarationsCurrent(
			declarationFileHeader(FFI_DECLARATIONS_NAME),
			libraries.libraries.map((entry) => ({
				name: entry.contract.name,
				plan: entry.plan,
			})),
		)
	) {
		reporter.warning(
			`${FFI_DECLARATIONS_NAME} no longer matches the C libraries; run maligator ffi types`,
		);
	}
	const frontendConfig =
		libraries === undefined
			? buildConfig
			: { ...buildConfig, ffiModules: libraries.modules };

	const compiledNativeOutput = command.kind !== "build" || command.internal.compiled;
	const developmentFragments =
		command.kind === "build" &&
		!production &&
		command.internal.compiled &&
		command.internal.serializePath === undefined &&
		process.env.MALIGATOR_DEVELOPMENT_FRAGMENTS !== "0";
	const execution = resolveExecution(command, buildConfig, {
		compiled:
			command.kind === "build" && !developmentFragments
				? command.internal.compiled && command.internal.serializePath === undefined
				: command.profile,
		optimization: production ? "full" : "development",
		target:
			command.kind === "build" && command.target !== undefined
				? executionTarget(command.target)
				: hostExecutionTarget(process.platform, process.arch),
	});
	const compilerDiagnostics = command.kind === "build" && command.internal.dumpCore;
	const relocatable = interpreted || developmentFragments;
	const compilerPhases: Array<{ phase: string; durationMs: number }> = [];
	const frontendOptions: CompileBuildFrontendOptions = {
		platformSourceRoot: context.installation.platformSourceRoot,
		entrypoint: entrypointPath,
		config: frontendConfig,
		execution,
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
		// Verbose output recompiles for the optimizer report, but a forced compile also
		// replaces dependency fragments with one image, which would change what is built.
		forceCompile:
			debugEnabled || compilerDiagnostics || (reporter.verbose && !relocatable),
		relocatable,
		interpreted,
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
		const warnings = frontend.diagnostics.map(
			(diagnostic) =>
				`${diagnostic.path}:${diagnostic.line}:${diagnostic.column} ` +
				`[${diagnostic.code}] ${diagnostic.message}`,
		);
		// A watched rebuild replays unchanged dependencies' warnings; repeat none of them.
		const previousWarnings = context.developmentCache?.warnings.get(entrypointPath);
		for (const warning of warnings)
			if (previousWarnings?.has(warning) !== true) reporter.warning(warning);
		context.developmentCache?.warnings.set(entrypointPath, new Set(warnings));
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
		const serializePath =
			command.kind === "build" ? command.internal.serializePath : undefined;
		const nativeHostInstalls = frontend.nativeHostInstalls;
		if (!relocatable && nativeHostInstalls === undefined)
			throw new Error("native frontend is missing host installers");
		const hostInstalls = nativeHostInstalls ?? [];
		const embedDeclarations =
			nativeHostInstalls === undefined
				? embedDeclarationsOfWires([
						...(frontend.wires ?? [frontend.wire]),
						...frontend.workerImages.map((worker) => worker.wire),
					])
				: embedDeclarationsOf(
						hostInstalls.map((installers) => ({ hostInstalls: installers })),
					);
		const declared = embedDeclarations.length === 0 ? {} : { embedDeclarations };
		if (serializePath !== undefined && embedDeclarations.length > 0)
			commandError("error: embedded assets are not supported by portable wire output");
		// Only `build` embeds; every other command reads declared files live.
		const assets =
			command.kind === "build" && serializePath === undefined
				? reporter.phase("Collect assets", () => {
						try {
							runBuildProducers(producerTasks(embedDeclarations, "build"), writeStderr);
							return collectEmbeddedAssets(
								embedDeclarations,
								{ cacheDirectory: maligatorCacheDirectory(), session: frontendSession },
								production,
							);
						} catch (error) {
							if (error instanceof BuildConfigError)
								commandError(`error: ${error.message}`);
							throw error;
						}
					})
				: [];
		const dependencies = [
			...new Set([
				...frontend.dependencies,
				...assets.flatMap((asset) => asset.files.map((file) => file.inputPath)),
				...(libraries?.dependencies ?? []),
			]),
		].sort();
		const dependencyIdentities = frontendSession.dependencyIdentities(dependencies);
		reporter.detail("Dependencies", dependencies.length);
		for (const dependency of dependencies) reporter.detail("Dependency", dependency);

		const stats = frontend.imageStats;
		reporter.detail("Functions", stats.functionCount);
		reporter.detail("Instructions", stats.instructionCount);

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
			return {
				serializedPath: serializePath,
				dependencies,
				dependencyIdentities,
				...declared,
			};
		}

		const shims =
			!interpreted || libraries === undefined || libraryTools === undefined
				? []
				: reporter.phase("Prepare C library shims", () =>
						prepareDevelopmentShims(
							libraries,
							libraryTools,
							context.installation.runtimeDirectory,
						),
					);
		const linkedLibraries = shims.some((shim) => shim.kind === "linked")
			? libraries
			: undefined;
		for (const shim of shims) {
			reporter.detail(
				`C library ${shim.library} development runtime`,
				shim.kind === "shim"
					? `shared shim (${shim.path})`
					: `linked runner (${shim.reason})`,
			);
		}
		const shimArguments = developmentShimArguments(
			linkedLibraries === undefined
				? shims.flatMap((shim) => (shim.kind === "shim" ? [shim.path] : []))
				: [],
		);
		const prebuiltExecutable =
			embeddedRunner?.executablePath ??
			(linkedLibraries === undefined ? packagedRunner : undefined);
		const workerManifest =
			command.kind === "build"
				? undefined
				: cacheDevelopmentWorkerManifest(frontend.workerImages);
		if (command.kind !== "build" && prebuiltExecutable !== undefined) {
			const wirePaths = reporter.phase("Cache development image", () =>
				frontend.runtimeArtifacts.map((artifact) => artifact.path),
			);
			const runArguments = workerManifestArguments(workerManifest).concat(shimArguments, [
				"--maligator-internal-run-wires",
				String(wirePaths.length),
				entrypointPath,
				...wirePaths,
				...command.programArgs,
			]);
			reporter.detail("Execution backend", "packaged development runtime");
			reporter.detail("Development images", wirePaths.join(", "));
			reporter.complete("Ready", prebuiltExecutable, false);
			return {
				...(embeddedRunner?.inProcess
					? {
							applicationImage: {
								schema: 2 as const,
								wires: frontend.runtimeArtifacts.map((artifact) => ({
									path: artifact.path,
									sha256: artifact.digest,
								})),
								entryPath: entrypointPath,
								...(workerManifest === undefined
									? {}
									: { workerManifestPath: workerManifest }),
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
				binaryPath: prebuiltExecutable,
				runArguments,
				dependencies,
				dependencyIdentities,
				...declared,
			};
		}
		if (packagedRunner !== undefined) ({ toolchain, plan } = resolveLocalTools());

		const evalCompiler = context.installation.evalCompiler;
		const compilerBake =
			evalCompiler.kind === "source"
				? {
						kind: "source" as const,
						sourceDirectory: evalCompiler.sourceDirectory,
						entrypoint: evalCompiler.entrypoint,
						bake: () =>
							compileEntrypointToBuffer(evalCompiler.entrypoint, {
								...embeddedCompilerOptions(evalCompiler.sourceDirectory),
								stripTypes: context.stripTypes,
							}),
						bakeProgram: () =>
							compileEntrypoint(evalCompiler.entrypoint, {
								...embeddedCompilerOptions(evalCompiler.sourceDirectory),
								stripTypes: context.stripTypes,
							}),
					}
				: { kind: "prebuilt" as const, path: evalCompiler.wirePath };
		// Wire drivers resolve installers by name, so they link every component.
		const resolvesInstallers = interpreted || developmentFragments;
		const usesHost = resolvesInstallers || hostInstalls.some(imageUsesHost);
		const usesUrlParser = resolvesInstallers || hostInstalls.some(imageUsesUrlParser);
		const linkDerivation = buildDerivationFromConfig(
			buildConfig,
			usesHost,
			usesUrlParser,
		);
		const derivation = command.profile
			? {
					features: normalizeNativeFeatures({
						...linkDerivation.features,
						profileEnabled: command.profile,
					}),
					cacheSuffix: [
						linkDerivation.cacheSuffix,
						"profile",
						command.profileCompiler ? "compiler" : "",
					]
						.filter((part) => part !== "")
						.join("-"),
				}
			: linkDerivation;
		reporter.detail(
			"Rust features",
			derivation.features.cargoFeatures.length === 0
				? "(none)"
				: derivation.features.cargoFeatures.join(", "),
		);
		const selectedFfiExports =
			production && frontend.closure.sourceClosure.kind === "known"
				? new Map<string, Set<string>>()
				: undefined;
		if (selectedFfiExports !== undefined) {
			for (const installers of hostInstalls) {
				for (const install of installers) {
					let names = selectedFfiExports.get(install.installer);
					if (names === undefined) {
						names = new Set();
						selectedFfiExports.set(install.installer, names);
					}
					for (const entry of install.exports) names.add(entry.name);
				}
			}
		}
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
		if (interpreted) {
			const wirePaths = reporter.phase("Cache development image", () =>
				frontend.runtimeArtifacts.map((artifact) => artifact.path),
			);
			reporter.detail("Execution backend", "interpreted development image");
			reporter.detail("Development images", wirePaths.join(", "));
			const runnerKey = localDevelopmentRunnerKey(
				nativeContext,
				linkedLibraries?.identity,
			);
			const retainedRunner = context.developmentCache?.runners.get(runnerKey);
			const useRetainedRunner =
				retainedRunner !== undefined && existsSync(retainedRunner);
			const binaryPath = reporter.phase(
				"Prepare development runtime",
				() => {
					if (useRetainedRunner) return retainedRunner;
					const built =
						linkedLibraries === undefined
							? buildSharedDevelopmentRunner(nativeContext, verbose)
							: buildDevelopmentRunner(
									nativeContext,
									verbose,
									`ffi-${linkedLibraries.identity}`,
									nativeLibraryInputs(
										linkedLibraries,
										context.installation.runtimeDirectory,
									),
								).binaryPath;
					context.developmentCache?.runners.set(runnerKey, built);
					return built;
				},
				() => {
					if (useRetainedRunner) return "development runtime cache hit";
					const caches = (["runtime", "rust", "binary"] as const)
						.map((artifact) =>
							nativeCache.has(artifact)
								? `${artifact} cache ${nativeCache.get(artifact) ? "hit" : "miss"}`
								: undefined,
						)
						.filter((value) => value !== undefined);
					return caches.join(" · ");
				},
				{ elapsed: !useRetainedRunner },
			);
			reporter.complete("Ready", binaryPath, false);
			return {
				binaryPath,
				runArguments: [
					...workerManifestArguments(workerManifest),
					...shimArguments,
					"--maligator-internal-run-wires",
					String(wirePaths.length),
					entrypointPath,
					...wirePaths,
					...command.programArgs,
				],
				dependencies,
				dependencyIdentities,
				...declared,
			};
		}

		const nativeLibraries =
			libraries === undefined
				? undefined
				: nativeLibraryInputs(
						libraries,
						context.installation.runtimeDirectory,
						selectedFfiExports,
					);
		const warn = (warning: string) => reporter.warning(warning);
		function* generatedUnits(onWarning = warn) {
			if (developmentFragments) {
				yield* developmentFragmentUnits(
					frontend.runtimeArtifacts,
					frontend.fragmentCompilerArtifacts,
					entrypointPath,
					maligatorCacheDirectory(),
					assets,
				);
			} else {
				yield* emitProgramTranslationUnits(frontend.programImage, {
					sourcePath: nativeSourcePath,
					partitionRoot: process.cwd(),
					compiled: compiledNativeOutput,
					assets,
					onRendererBailout: ({ file, name }) =>
						onWarning(
							`${file}: ${name || "<anonymous>"} runs in the bytecode interpreter because native code generation declined it`,
						),
				});
			}
			yield* emitWorkerImageTranslationUnits(frontend.workerImages, {
				sourcePath: nativeSourcePath,
				partitionRoot: process.cwd(),
				compiled: compiledNativeOutput,
				assets,
			});
		}
		if (command.kind === "build" && command.internal.emitC) {
			for (const unit of generatedUnits())
				writeSourceChunks(1, [...unit.sourceChunks, "\n"]);
			return { dependencies, dependencyIdentities, ...declared };
		}
		const sourceOutput = {
			context: nativeContext,
			name,
			cacheSuffix: derivation.cacheSuffix,
		};
		const cacheNativeSources =
			command.kind === "build" &&
			production &&
			compiledNativeOutput &&
			!frontendOptions.forceCompile &&
			!command.profile &&
			command.internal.coreReport === undefined;
		const nativeImageIdentity = cacheNativeSources
			? frontend.nativeImageIdentity
			: undefined;
		const output = reporter.phase(
			"Generate native code",
			() =>
				nativeImageIdentity === undefined
					? prepareGeneratedSources(sourceOutput, generatedUnits())
					: prepareCachedGeneratedSources(
							sourceOutput,
							{ image: nativeImageIdentity, directory: process.cwd(), assets },
							generatedUnits,
							warn,
						),
			(result) =>
				result.cache === undefined ? undefined : `source cache ${result.cache}`,
		);
		reporter.detail("Translation units", output.units.length);
		reporter.detail("Generated C bytes", output.sourceCodeUnits);
		const binaryPath = reporter.phase(
			"Build native binary",
			() =>
				buildLocalBinary({
					context: nativeContext,
					name,
					cSource: output,
					...nativeLibraries,
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
					mainFile: developmentFragments
						? path.join(context.installation.runtimeDirectory, DEVELOPMENT_FRAGMENT_MAIN)
						: applicationDriverPath(
								context.installation,
								usesHost ||
									imageNeedsHostEventLoop(hostInstalls[0] ?? []) ||
									nativeLibraries?.needsHostEventLoop === true,
								frontend.workerImages.length > 0,
							),
					cacheSuffix: derivation.cacheSuffix,
				}).binaryPath,
			() => {
				const caches = (["runtime", "rust", "binary"] as const)
					.map((artifact) =>
						nativeCache.has(artifact)
							? `${artifact} cache ${nativeCache.get(artifact) ? "hit" : "miss"}`
							: undefined,
					)
					.filter((value) => value !== undefined);
				caches.push(`${generatedObjectHits}/${generatedObjects} objects cached`);
				return caches.join(" · ");
			},
			{ elapsed: true },
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
						licensePaths: context.installation.licensePaths,
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
				...declared,
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
			...declared,
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

function formatApplicationError(error: unknown): string {
	return error instanceof Error ? error.stack || error.toString() : String(error);
}

function reportRunOutcome(outcome: ApplicationRunOutcome): void {
	if (outcome.applicationExit?.reason === "error") {
		writeStderr(
			`Application error: ${formatApplicationError(outcome.applicationExit.error)}`,
		);
	}
	if (outcome.signal !== undefined) writeStderr(`Exited with signal ${outcome.signal}`);
	else if (outcome.status !== undefined && outcome.status !== 0)
		writeStderr(`Exited with code ${outcome.status}`);
}

/** Compile, link, and execute one parsed `run` command. */
export async function runCommand(
	command: RunCommand,
	context: CommandContext,
): Promise<ApplicationRunOutcome> {
	const result =
		context.compiler === undefined
			? prepareCommand(command, context, true)
			: await context.compiler.prepare(command, { compact: true });
	const producers = new CommandProducers("run", writeStderr);
	try {
		await producers.prepare(result.embedDeclarations ?? []);
		return await runPreparedCommand(command, context, result);
	} catch (error) {
		if (error instanceof BuildConfigError) commandError(`error: ${error.message}`);
		throw error;
	} finally {
		await producers.close();
	}
}

async function runPreparedCommand(
	command: RunCommand,
	context: CommandContext,
	result: BuildCommandResult,
): Promise<ApplicationRunOutcome> {
	const binaryPath = result.binaryPath!;
	if (
		!command.profile &&
		result.applicationImage !== undefined &&
		context.applications !== undefined
	) {
		const application = launchApplication(result, command.programArgs, context);
		try {
			// An error or explicit exit during evaluation also settles the joined exit.
			await application.evaluated.catch(() => {});
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
					{
						workloadSucceeded: outcome.status === 0 && outcome.signal === undefined,
					},
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
	retainListeners = false,
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
				retainListeners,
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
		return stats.isFile() || stats.isDirectory()
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
			warnings: new Map(),
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
	// Embedded assets are read live outside `build`, so dev watches only module files.
	const directories: Array<string> = [];
	let states = watchedFiles(command, initialDependencies);
	const watchHost = context.developmentWatcher;
	const watchHandle = watchHost?.create(
		states.map((state) => state.file),
		directories,
	);
	const shutdown = new AbortController();
	const restorations = new Set<Promise<void>>();
	const restorationFailures: Array<unknown> = [];
	let child: LaunchedApplication | undefined;
	let childGeneration = 0;
	let activeBuild: BuildCommandResult | undefined;
	let activeGeneration = 0;
	let verifiedDependencies = new Map<string, FrontendDependencyIdentity>();
	const applicationEvaluationFailed = new Error("Application evaluation failed");
	const spawnApplication = (build: BuildCommandResult, generation: number) => {
		activeProfile = nextProfile(build);
		// The next generation adopts the listening sockets this one leaves, so a
		// request during the restart waits instead of being refused.
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
			true,
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
		if (exit?.reason === "error") {
			// Status snapshots repeat past events, so render the stack on its own line.
			writeStderr(`Application error: ${formatApplicationError(exit.error)}`);
		}
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
					context.applications?.releaseUnclaimedListeners?.();
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
	// Asset watchers outlive application generations: they stop with the session.
	const producers = new CommandProducers("dev", writeStderr);
	const development = createDevelopmentSession(command, compiler, {
		async publish(build, generation, isCurrent, signal) {
			if (!isCurrent()) return false;
			watchHost?.update(
				watchHandle,
				states.map((state) => state.file),
				directories,
			);
			const verified = new Map<string, FrontendDependencyIdentity>();
			const validate = () => {
				const changed = new Set(changedFiles(states, true));
				for (const identity of build.dependencyIdentities ?? []) {
					const previous =
						verified.get(identity.path) ?? verifiedDependencies.get(identity.path);
					if (revalidateFrontendDependency(identity, previous))
						verified.set(identity.path, identity);
					else changed.add(identity.path);
				}
				return [...changed];
			};
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
				...directories,
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
				directories,
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
				await producers.prepare(build.embedDeclarations ?? []);
				launched = spawnApplication(build, generation);
				await awaitApplicationEvaluation(launched, signal);
			} catch (error) {
				if (launched !== undefined) await stopApplication();
				restoreActiveApplication();
				if (!isCurrent()) return false;
				if (launched?.exit?.()?.reason === "error") throw applicationEvaluationFailed;
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
			verifiedDependencies = verified;
			// Sockets the new generation did not listen on during evaluation belong to
			// servers the edit removed.
			context.applications?.releaseUnclaimedListeners?.();
			return true;
		},
		failed(error) {
			if (
				error === applicationEvaluationFailed ||
				(error instanceof SyntaxDiagnostic && error.location !== undefined)
			) {
				if (error instanceof SyntaxDiagnostic) writeStderr(renderSyntaxDiagnostic(error));
				writeStderr(
					child === undefined
						? "Rebuild failed. Waiting for changes."
						: "Rebuild failed. Last successful application is still running.",
				);
				return;
			}
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
			context.applications?.releaseUnclaimedListeners?.();
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
			directories,
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
		try {
			await producers.close();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1)
		throw new AggregateError(failures, "development shutdown failed");
}

const PROFILED_TEST_RESULT_PREFIX = "__MALIGATOR_TEST_RESULT__";

function testToolchain(
	context: CommandContext,
	environment: NodeJS.ProcessEnv = process.env,
): Toolchain {
	try {
		return requireToolchain(
			nativeToolchainOptions(context.installation.runtimeDirectory, { env: environment }),
		);
	} catch (error) {
		if (error instanceof ToolchainError) commandError(error.message);
		throw error;
	}
}

function testRunnerFeatures(config: ResolvedBuildConfig, applicationHost: boolean) {
	return normalizeNativeFeatures({
		...buildDerivationFromConfig(config).features,
		developmentApiEnabled: applicationHost,
	});
}

function prepareTestRunnerLibraries(
	config: ResolvedBuildConfig,
	context: CommandContext,
	environment: NodeJS.ProcessEnv,
	packagedRunner: string | undefined,
) {
	if (Object.keys(config.ffi).length === 0) return undefined;
	const toolchain =
		packagedRunner === undefined ? testToolchain(context, environment) : undefined;
	const tools =
		toolchain !== undefined
			? libraryBuildTools(toolchain, environment)
			: developmentShimTools(environment);
	const libraries = prepareConfiguredLibraries(config, context, tools);
	return libraries === undefined ? undefined : { libraries, tools, toolchain };
}

function buildIsolatedTestRunner(
	context: CommandContext,
	config: ResolvedBuildConfig,
	options: {
		bindings: ReturnType<typeof prepareTestRunnerLibraries>;
		packagedRunner: string | undefined;
		environment: NodeJS.ProcessEnv;
		applicationHost: boolean;
	},
): { binaryPath: string; shims: Array<string> } {
	const { bindings, packagedRunner, environment, applicationHost } = options;
	const runtimeDirectory = context.installation.runtimeDirectory;
	const shims =
		bindings === undefined
			? []
			: prepareDevelopmentShims(bindings.libraries, bindings.tools, runtimeDirectory);
	const linkedLibraries = shims.some((shim) => shim.kind === "linked")
		? bindings?.libraries
		: undefined;
	const shimPaths = shims.flatMap((shim) => (shim.kind === "shim" ? [shim.path] : []));
	if (linkedLibraries === undefined && packagedRunner !== undefined)
		return { binaryPath: packagedRunner, shims: shimPaths };

	const derivation = buildDerivationFromConfig(config);
	const toolchain = bindings?.toolchain ?? testToolchain(context, environment);
	const evalCompiler = context.installation.evalCompiler;
	const compilerBake =
		evalCompiler.kind === "source"
			? {
					kind: "source" as const,
					sourceDirectory: evalCompiler.sourceDirectory,
					entrypoint: evalCompiler.entrypoint,
					bake: () =>
						compileEntrypointToBuffer(evalCompiler.entrypoint, {
							...embeddedCompilerOptions(evalCompiler.sourceDirectory),
							stripTypes: context.stripTypes,
						}),
					bakeProgram: () =>
						compileEntrypoint(evalCompiler.entrypoint, {
							...embeddedCompilerOptions(evalCompiler.sourceDirectory),
							stripTypes: context.stripTypes,
						}),
				}
			: { kind: "prebuilt" as const, path: evalCompiler.wirePath };
	const nativeContext = resolveNativeBuildContext({
		toolchain,
		environment,
		plan: selectNativeBuildPlan(toolchain, false),
		runtimeDirectory,
		features: testRunnerFeatures(config, applicationHost),
		compilerBake,
	});
	if (linkedLibraries === undefined) {
		return {
			binaryPath: buildSharedDevelopmentRunner(nativeContext, false),
			shims: shimPaths,
		};
	}
	return {
		binaryPath: buildDevelopmentRunner(
			nativeContext,
			false,
			`${derivation.cacheSuffix}${applicationHost ? "-test-host" : ""}`,
			nativeLibraryInputs(linkedLibraries, runtimeDirectory),
		).binaryPath,
		shims: [],
	};
}

function prepareLinkedTestHost(
	config: ResolvedBuildConfig,
	context: CommandContext,
): PreparedLinkedTestHost {
	const entry = context.installation.testHostModulePath;
	if (entry === undefined)
		throw new Error("this installation does not include the linked test host driver");
	const environment = process.env;
	const packagedRunner = packagedDevelopmentRunner(
		context.installation.runtimeDirectory,
		testRunnerFeatures(config, true),
		environment,
	);
	const bindings = prepareTestRunnerLibraries(
		config,
		context,
		environment,
		packagedRunner,
	);
	const libraries = bindings?.libraries;
	const testConfig =
		libraries === undefined ? config : { ...config, ffiModules: libraries.modules };
	const driverFiles = [entry, path.join(path.dirname(entry), "host-protocol.mts")];
	const dependencies = [
		...new Set([...(libraries?.dependencies ?? []), ...driverFiles]),
	].sort();
	context.onFfiDependencies?.(dependencies);
	const identity = artifactIdentity({
		libraries: libraries?.identity,
		engine: config.engine,
		compiler: bindings?.tools.compiler,
		toolchain: bindings?.toolchain?.fingerprint,
		packagedRunner,
		runtime: context.installation.runtimeDirectory,
		driver: driverFiles.map((file) => [
			file,
			artifactDigest(new Uint8Array(readFileSync(file))),
		]),
	});
	return {
		config: testConfig,
		native: {
			identity,
			dependencies: dependencies.map((file) =>
				new FrontendCompilationSession().snapshot(file),
			),
		},
		build() {
			const frontend = compileBuildFrontend({
				entrypoint: entry,
				config: testConfig,
				platformSourceRoot: context.installation.platformSourceRoot,
				stripTypes: context.stripTypes,
				stripperIdentity: context.installation.frontendIdentity,
				optimization: "development",
				interpreted: true,
			});
			const runner = buildIsolatedTestRunner(context, testConfig, {
				bindings,
				packagedRunner,
				environment,
				applicationHost: true,
			});
			return {
				executable: runner.binaryPath,
				shims: runner.shims,
				wires: frontend.runtimeArtifacts.map((artifact) => artifact.path),
				entry,
			};
		},
		validate() {
			const current = prepareLinkedTestHost(config, context);
			if (current.native.identity !== identity)
				throw new TestSourceChangedError([
					...new Set([
						...dependencies,
						...current.native.dependencies.map((dependency) => dependency.path),
					]),
				]);
		},
	};
}

async function executeIsolatedTests(
	command: TestCommand,
	context: CommandContext,
	config: ResolvedBuildConfig,
	embeddedRunner?: DevelopmentRunner,
	options: IsolatedTestExecutionOptions = {},
): Promise<TestCommandSummary> {
	const environment = options.environment ?? process.env;
	const stdout =
		options.stdout ??
		((text: string) => {
			process.stdout.write(text);
		});
	const packagedRunner =
		embeddedRunner === undefined
			? packagedDevelopmentRunner(
					context.installation.runtimeDirectory,
					testRunnerFeatures(config, false),
					environment,
				)
			: undefined;
	const bindings =
		embeddedRunner === undefined
			? prepareTestRunnerLibraries(config, context, environment, packagedRunner)
			: undefined;
	const libraries = bindings?.libraries;
	const testConfig =
		libraries === undefined ? config : { ...config, ffiModules: libraries.modules };
	const compiled = prepareIsolatedTestCommand(command, context, testConfig);
	const { binaryPath: runner, shims } =
		embeddedRunner === undefined
			? buildIsolatedTestRunner(context, testConfig, {
					bindings,
					packagedRunner,
					environment,
					applicationHost: false,
				})
			: { binaryPath: embeddedRunner.executablePath, shims: [] };
	const wirePaths =
		"wires" in compiled
			? compiled.wires.map((wire) => wire.path)
			: [cacheFrontendWire(compiled.wire)];
	const entrypoint = compiled.files[0]!;
	const workerManifest = cacheDevelopmentWorkerManifest(
		"workerImages" in compiled ? compiled.workerImages : [],
	);
	const args = [
		...workerManifestArguments(workerManifest),
		...developmentShimArguments(shims),
		"--maligator-internal-run-wires",
		String(wirePaths.length),
		entrypoint,
		...wirePaths,
	];
	options.onPrepared?.({
		dependencies: compiled.inputIdentities,
		binaryPath: runner,
		wirePaths,
	});
	const producers = new CommandProducers("test", writeStderr);
	const executionStartedAt = Date.now();
	let outcome: Awaited<ReturnType<typeof executeBinaryReported>>;
	try {
		await producers.prepare(
			embedDeclarationsOfWires(wirePaths.map((wire) => readFileSync(wire))),
		);
		outcome = await executeBinaryReported(runner, args, runEnv(environment), {
			timeoutMs: options.timeoutMs,
			resultPrefix: ISOLATED_TEST_RESULT_PREFIX,
			stdout: options.stdout,
			stderr: options.stderr,
		});
	} finally {
		await producers.close();
	}
	const executionMs = Date.now() - executionStartedAt;
	options.onExecution?.(outcome, executionMs);
	if (outcome.timedOut || outcome.status !== 0 || outcome.result === undefined) {
		commandError(
			`error: isolated test process ${
				outcome.timedOut
					? `timed out after ${options.timeoutMs}ms`
					: outcome.signal
						? `received ${outcome.signal}`
						: `exited with ${outcome.status ?? "unknown"}`
			}${outcome.result === undefined ? " without publishing a test result" : ""}`,
		);
	}
	let testResult: TestRunResult;
	try {
		testResult = JSON.parse(outcome.result) as TestRunResult;
	} catch (error) {
		commandError(
			`error: isolated test result was invalid: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return reportIsolatedTestResult(
		testResult,
		{
			files: compiled.files.length,
			discoveryMs: compiled.discoveryMs,
			frontendMs: compiled.frontendMs,
			executionMs,
			cacheHits: compiled.cache === "hit" ? 1 : 0,
			cacheMisses: compiled.cache === "miss" ? 1 : 0,
			artifactHits: "artifactHits" in compiled ? compiled.artifactHits : 0,
			artifactMisses: "artifactMisses" in compiled ? compiled.artifactMisses : 0,
		},
		(message = "") => stdout(`${message}\n`),
	);
}

async function executeProfiledTests(
	command: TestCommand,
	context: CommandContext,
	config: ResolvedBuildConfig,
): Promise<TestCommandSummary> {
	const verbose = command.verbose === true;
	const reporter = new BuildReporter(
		verbose,
		!verbose,
		context.checkpoint,
		context.onCompilationPhase,
	);
	reporter.start("tests", "production", "Preparing");
	reporter.detail(
		"Profile",
		command.profileCompiler === true ? "compiler counters" : "sampling",
	);
	const libraries = reporter.phase("Prepare C libraries", () =>
		prepareConfiguredLibraries(
			config,
			context,
			libraryBuildTools(testToolchain(context)),
		),
	);
	const compiled = reporter.phase("Compile modules", () =>
		prepareProfiledTestCommand(
			command,
			context,
			libraries === undefined ? config : { ...config, ffiModules: libraries.modules },
			(label, run) => reporter.phase(label, run),
		),
	);
	reporter.detail("Test files", compiled.files.length);
	reporter.timing("Test discovery", compiled.discoveryMs);
	reporter.timing("Test frontend", compiled.frontendMs);
	const hostInstalls = [
		compiled.programImage,
		...compiled.workerImages.map(({ image }) => image),
	].map(({ runtime }) => runtime.hostInstalls);
	const usesHost = hostInstalls.some(imageUsesHost);
	const baseDerivation = buildDerivationFromConfig(
		config,
		usesHost,
		hostInstalls.some(imageUsesUrlParser),
	);
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
	const toolchain = testToolchain(context);
	const evalCompiler = context.installation.evalCompiler;
	const compilerBake =
		evalCompiler.kind === "source"
			? {
					kind: "source" as const,
					sourceDirectory: evalCompiler.sourceDirectory,
					entrypoint: evalCompiler.entrypoint,
					bake: () =>
						compileEntrypointToBuffer(evalCompiler.entrypoint, {
							...embeddedCompilerOptions(evalCompiler.sourceDirectory),
							stripTypes: context.stripTypes,
						}),
					bakeProgram: () =>
						compileEntrypoint(evalCompiler.entrypoint, {
							...embeddedCompilerOptions(evalCompiler.sourceDirectory),
							stripTypes: context.stripTypes,
						}),
				}
			: { kind: "prebuilt" as const, path: evalCompiler.wirePath };
	const nativeContext = reporter.phase("Prepare native build", () =>
		resolveNativeBuildContext({
			environment: compilerProfileBuildEnvironment(command),
			toolchain,
			plan: selectNativeBuildPlan(toolchain, true),
			runtimeDirectory: context.installation.runtimeDirectory,
			features: derivation.features,
			compilerBake,
			onCacheEvent: (event) =>
				reporter.detail(
					`${event.artifact} cache`,
					`${event.hit ? "hit" : "miss"} (${event.path})`,
				),
			onBuildPhase: (event) =>
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
				),
			onCommand: verbose
				? (event) =>
						reporter.detail(
							"Command",
							[event.tool, ...event.args]
								.map((argument) =>
									/^[A-Za-z0-9_./:@%+=,-]+$/.test(argument)
										? argument
										: JSON.stringify(argument),
								)
								.join(" "),
						)
				: undefined,
		}),
	);
	const emitOptions = {
		sourcePath: nativeSourcePath,
		compiled: true,
	};
	const source = reporter.phase("Generate native code", () => [
		...emitProgramTranslationUnits(compiled.programImage, emitOptions),
		...emitWorkerImageTranslationUnits(compiled.workerImages, emitOptions),
	]);
	reporter.detail("Translation units", source.length);
	reporter.detail(
		"Generated C code units",
		source.reduce((total, unit) => total + unit.sourceCodeUnits, 0),
	);
	const nativeLibraries =
		libraries === undefined
			? undefined
			: nativeLibraryInputs(libraries, context.installation.runtimeDirectory);
	const binary = reporter.phase(
		"Build native binary",
		() =>
			buildLocalBinary({
				context: nativeContext,
				name: "maligator-profile-test",
				cSource: source,
				...nativeLibraries,
				verbose,
				onWarning: (warning) => reporter.warning(warning),
				onGeneratedObject: (event) =>
					reporter.detail(
						`Generated C object · ${event.generatedKind ?? event.role} · ${event.unit}`,
						`${event.cache} · source ${formatCacheBytes(event.sourceBytes)} · object ${formatCacheBytes(event.objectBytes)}${event.compileDurationMs === null ? "" : ` · compile ${event.compileDurationMs.toFixed(1)} ms`}`,
					),
				mainFile: applicationDriverPath(
					context.installation,
					usesHost ||
						imageNeedsHostEventLoop(compiled.programImage.runtime.hostInstalls) ||
						nativeLibraries?.needsHostEventLoop === true,
					compiled.workerImages.length > 0,
				),
				cacheSuffix: derivation.cacheSuffix,
			}).binaryPath,
		undefined,
		{ elapsed: true },
	);
	const profile = reporter.phase("Prepare profile metadata", () =>
		prepareProfile(
			binary,
			compiled.programImage,
			command.profileCompiler === true ? "compiler" : "sampling",
			{
				coreOptimizationReport: compiled.optimizationReport,
				coreOptimizationPlan: compiled.optimizationPlan,
			},
		),
	);
	const capture = reporter.phase("Start profile capture", () =>
		createProfileCapture("test", profile),
	);
	const producers = new CommandProducers("test", writeStderr);
	const executionStartedAt = Date.now();
	let outcome: Awaited<ReturnType<typeof executeBinaryReported>>;
	try {
		await producers.prepare(
			embedDeclarationsOf([
				compiled.programImage.runtime,
				...compiled.workerImages.map((worker) => worker.image.runtime),
			]),
		);
		outcome = await reporter.phaseAsync("Run profiled tests", () =>
			executeBinaryReported(
				binary,
				[],
				{
					...runEnv(),
					...capture.environment,
					...compilerProfileRuntimeEnvironment(command),
				},
				{ resultPrefix: PROFILED_TEST_RESULT_PREFIX },
			),
		);
	} finally {
		await producers.close();
	}
	const executionMs = Date.now() - executionStartedAt;
	if (outcome.status !== 0 || outcome.result === undefined) {
		commandError(
			`error: production-profile test process ${
				outcome.signal
					? `received ${outcome.signal}`
					: `exited with ${outcome.status ?? "unknown"}`
			}${outcome.result === undefined ? " without publishing a test result" : ""}`,
		);
	}
	let testResult: TestRunResult;
	try {
		testResult = JSON.parse(outcome.result) as TestRunResult;
	} catch (error) {
		commandError(
			`error: production-profile test result was invalid: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (existsSync(capture.capturePath)) {
		const finalized = reporter.phase("Finalize profile capture", () =>
			finalizeProfileCapture(capture.directory, profile, "test", {
				workloadSucceeded: testResult.failed === 0,
			}),
		);
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
		if (args[0] === "--maligator-internal-test-runtime-image") {
			if (args.length !== 2) {
				throw new Error("test runtime worker requires one request path");
			}
			compileTestRuntimeRequest(args[1]!, context.stripTypes);
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
			((command.kind === "run" || command.kind === "dev" || command.kind === "test") &&
				command.verbose === true) ||
			(command.kind === "doctor" && command.verbose);
		if (command.kind === "help") {
			log.info(formatCliHelp(command.command));
			return;
		}
		if (command.kind === "version") {
			log.info(MALIGATOR_VERSION);
			return;
		}
		if (command.kind === "init") {
			const { entry, messages } = initProject();
			for (const message of messages) log.info(message);
			log.info(
				`\nNext steps\n  maligator run ${entry}\n  maligator dev\n  maligator test`,
			);
			return;
		}
		if (command.kind === "doctor") {
			loadBuildConfig(undefined, process.cwd(), context.stripTypes);
			const report = inspectToolchain(
				nativeToolchainOptions(
					context.installation.runtimeDirectory,
					{ target: command.target },
					"report",
				),
			);
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
		if (command.kind === "ffi") {
			await runFfiCommand(command, context);
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
					const hosts = new LinkedTestHostSession(context.applications);
					const watchContext = { ...context, testApplications: hosts };
					const watchConfig = async (controls?: TestGenerationControls) => {
						const current = loadCommandConfig(command, context.stripTypes);
						if (
							context.applications === undefined ||
							compatibleDevelopmentRunner(current, context)?.inProcess !== true
						) {
							if (controls === undefined) return current;
							return await hosts.activate(
								prepareLinkedTestHost(current, {
									...context,
									onFfiDependencies(paths) {
										context.onFfiDependencies?.(paths);
										controls.discoveredPaths?.(paths);
									},
								}),
								controls,
							);
						}
						if (controls !== undefined) await hosts.useLocal();
						return current;
					};
					try {
						await watchTestCommand(command, watchContext, watchConfig);
					} finally {
						await hosts.close();
					}
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
					? await executeProfiledTests(command, context, config)
					: developmentRunner?.inProcess === true
						? await executeTestCommand(command, context, config)
						: await executeIsolatedTests(command, context, config, developmentRunner);
			} catch (error) {
				if (error instanceof SyntaxDiagnostic || error instanceof CommandError)
					throw error;
				commandError(`error: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (result.exitCode !== 0) exitCode = result.exitCode;
		}
	} catch (error) {
		if (error instanceof CliUsageError) {
			writeStderr(`error: ${error.message}`);
			writeStderr(
				"Run 'maligator <command> --help' for command usage or 'maligator --help' to list commands.",
			);
			exitCode = 2;
		} else if (error instanceof CommandError) {
			writeStderr(error.message);
			exitCode = error.exitCode;
		} else if (error instanceof MaligatorCacheRootError) {
			writeStderr(`error: ${error.message}`);
			exitCode = 1;
		} else if (error instanceof SyntaxDiagnostic && error.location !== undefined) {
			writeStderr(renderSyntaxDiagnostic(error));
			if (verbose && error.stack !== undefined) writeStderr(error.stack);
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

/** Where `ffi types` writes declarations unless `--out` names another file. */
const FFI_DECLARATIONS_NAME = "maligator-ffi.d.ts";

async function runFfiCommand(
	command: FfiCommand,
	context: CommandContext,
): Promise<void> {
	const projectRoot = process.cwd();
	try {
		const config = loadBuildConfig(command.configPath, projectRoot, context.stripTypes);
		const report = inspectToolchain({
			rustDir: path.join(context.installation.runtimeDirectory, "rust"),
			target: command.target,
			needsCxx: false,
		});
		const compiler = report.tools.cc;
		if (compiler === undefined) {
			commandError(formatToolchainReport(report, report.platform ?? process.platform));
		}
		const preparation = {
			projectRoot,
			stripTypes: context.stripTypes,
			compiler,
			environment: {
				...process.env,
				...report.toolchain?.environmentOverrides,
			},
			platform: report.platform ?? process.platform,
			cross: report.cross === true,
		};
		if (command.action === "check") {
			const names =
				command.library === undefined
					? Object.keys(config.ffi).sort()
					: [command.library];
			if (names.length === 0)
				commandError("error: maligator.build.ts declares no ffi libraries");
			const libraries = (
				command.probe === undefined ? names : Object.keys(config.ffi).sort()
			).map((name) => prepareLibrary(config, name, preparation));
			const selected = libraries.filter((library) =>
				names.includes(library.contract.name),
			);
			const development = buildDevelopmentShims(libraries, {
				...preparation,
				runtimeDirectory: context.installation.runtimeDirectory,
				portableDiagnostics: true,
			}).filter((entry) => names.includes(entry.library));
			const checkOptions = {
				file: path.resolve(projectRoot, command.outPath ?? "maligator-ffi.lock.json"),
				target:
					command.target ?? hostExecutionTarget(process.platform, process.arch).triple,
				update: command.probe === undefined && command.update,
				all: command.library === undefined,
			};
			let checked = checkLibraries(selected, checkOptions);
			if (command.probe !== undefined) {
				const probePath = path.resolve(projectRoot, command.probe.path);
				const probeCommand: TestCommand = {
					kind: "test",
					paths: [probePath],
					repeat: 1,
					bail: false,
					timeoutMs: command.probe.timeoutMs,
					compileConcurrency: 1,
					profile: false,
				};
				const probe = await runFfiProbe(
					{
						path: probePath,
						projectRoot,
						configFile: path.resolve(
							projectRoot,
							command.configPath ?? BUILD_CONFIG_NAME,
						),
						lockfile: checkOptions.file,
						timeoutMs: command.probe.timeoutMs,
						environment: preparation.environment,
						libraries,
					},
					(options) =>
						executeIsolatedTests(probeCommand, context, config, undefined, options),
				);
				if (probe.ok && command.update)
					checked = checkLibraries(selected, { ...checkOptions, update: true });
				checked = { ...checked, ok: checked.ok && probe.ok, probe };
			}
			checked = { ...checked, development };
			if (command.json) {
				writeSourceChunks(1, ffiJsonChunks(checked, "\t"));
				process.stdout.write("\n");
			} else log.info(formatFfiCheck(checked));
			if (!checked.ok)
				commandError(
					checked.probe?.ok === false
						? "error: the FFI probe failed; the snapshot was not accepted"
						: "error: C declarations or facts need review",
				);
			return;
		}
		if (command.action === "types") {
			const names = Object.keys(config.ffi).sort();
			if (names.length === 0) {
				commandError("error: maligator.build.ts declares no ffi libraries");
			}
			const outPath = path.resolve(projectRoot, command.outPath ?? FFI_DECLARATIONS_NAME);
			const libraries = names.map((name) => ({
				name,
				plan: prepareLibrary(config, name, preparation).plan,
			}));
			writeSourceChunks(outPath, generateDeclarations(libraries));
			log.info(`Wrote ${path.relative(projectRoot, outPath)} for ${names.join(", ")}`);
			return;
		}
		const prepared = prepareLibrary(config, command.library, preparation);
		const inspection = inspectBindings(
			prepared.contract,
			projectRoot,
			prepared.library,
			compiler,
			prepared.model,
			prepared.plan,
		);
		if (command.json) {
			writeSourceChunks(1, ffiJsonChunks(inspection, "\t"));
			process.stdout.write("\n");
		} else log.info(formatInspection(inspection));
	} catch (error) {
		if (error instanceof BuildConfigError || error instanceof FfiError) {
			commandError(`error: ${error.message}`);
		}
		throw error;
	}
}

function cacheSummaryLines(): Array<string> {
	const status = inspectMaligatorCache();
	const families = new Map<string, number>();
	for (const entry of status.entries) {
		families.set(entry.family, (families.get(entry.family) ?? 0) + entry.bytes);
	}
	const now = Date.now();
	const freeBytes = volumeFreeBytes(status.root);
	const budget = cacheBudget(freeBytes + status.totalBytes);
	const usage = readCacheUsage(status.root);
	return [
		`Root: ${status.root}`,
		`Total: ${formatCacheBytes(status.totalBytes)} (${formatCacheBytes(status.managedBytes)} managed)`,
		`Budget: prunes at ${formatCacheBytes(budget.maxBytes)} back to ${formatCacheBytes(budget.targetBytes)} (${formatCacheBytes(freeBytes)} free on its volume)`,
		usage === undefined
			? "Maintenance: not yet run"
			: `Maintenance: ${formatCommandDuration(now - usage.measuredAt)} ago, measured ${formatCacheBytes(usage.bytes)}, removed ${formatCacheBytes(usage.removedBytes)}`,
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
	if (command.action === "maintain") {
		// Started detached after other commands; nobody reads its output.
		try {
			os.setPriority(os.constants.priority.PRIORITY_LOW);
		} catch {
			// Hosts without process priorities run it at normal priority.
		}
		maintainMaligatorCache();
		return;
	}
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

	const minAgeMs = command.minAgeMs ?? DEFAULT_CACHE_MIN_AGE_MS;
	progress.start(`${command.dryRun ? "preview" : "prune"} stale rebuildable entries`);
	const maintenanceLabel = command.dryRun
		? "scan eligible entries"
		: "remove stale entries";
	progress.stage(1, 2, maintenanceLabel);
	const result = pruneMaligatorCache({
		maxBytes: command.maxBytes,
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
		`${formatCacheBytes(result.totalBytes)} remain · target ${formatCacheBytes(result.targetBytes)}`,
	);
	progress.complete();
}
