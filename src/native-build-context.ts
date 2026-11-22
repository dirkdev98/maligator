import { hash } from "node:crypto";
import * as path from "node:path";
import { normalizeNativeFeatures, selectNativeBuildPlan } from "./build-flags.ts";
import type {
	NativeBuildPlan,
	NativeFeatureInput,
	NativeFeatureSpec,
} from "./build-flags.ts";
import { maligatorCacheDirectory } from "./cache-root.ts";
import type { CompilerBakeInput } from "./compiler-bake.ts";
import { RELEASE_MACOS_VERSION } from "./prebuilt-runtime.ts";
import { packagedRuntimeRust } from "./rust-build.ts";
import { nativeRustTarget, requireToolchain } from "./toolchain.ts";
import type { InspectToolchainOptions, Toolchain, ToolExecutable } from "./toolchain.ts";

export interface BuildCacheEvent {
	artifact: "runtime" | "rust" | "binary";
	hit: boolean;
	path: string;
}

export interface NativeBuildPhaseEvent {
	phase:
		| "runtime"
		| "runtime prebuilt"
		| "runtime local build"
		| "runtime C projection"
		| "runtime C object reuse"
		| "runtime C object compile"
		| "runtime C · engine"
		| "runtime C · host"
		| "runtime C · runtime"
		| "rust"
		| "rust prebuilt"
		| "rust local build"
		| "write generated C"
		| "generated C projection"
		| "generated C objects"
		| "link"
		| "strip"
		| "publish binary";
	durationMs: number;
	subject?: string;
	units?: number;
	bytes?: number;
	cache?: "hit" | "miss";
	path?: string;
}

export interface NativeBuildCommandEvent {
	tool: string;
	args: ReadonlyArray<string>;
	cwd?: string;
}

export interface NativeBuildCommandResourceEvent extends NativeBuildCommandEvent {
	durationMs: number;
	userCpuMs: number;
	systemCpuMs: number;
	peakRssBytes?: number;
}

/** Every resolved input shared by the C archive, Rust archive, and final linker. */
export interface NativeBuildContext {
	readonly runtimeDirectory: string;
	readonly cacheDirectory: string;
	readonly features: Readonly<NativeFeatureSpec>;
	readonly toolchain: Toolchain;
	readonly runtimeObjectCompiler?: ToolExecutable;
	readonly plan: NativeBuildPlan;
	readonly compilerBake?: Readonly<CompilerBakeInput>;
	readonly environment: Readonly<NodeJS.ProcessEnv>;
	readonly environmentFingerprint: string;
	readonly onCacheEvent?: (event: BuildCacheEvent) => void;
	readonly onBuildPhase?: (event: NativeBuildPhaseEvent) => void;
	readonly onCommand?: (event: NativeBuildCommandEvent) => void;
	readonly measureCommandResources: boolean;
	readonly onCommandResource?: (event: NativeBuildCommandResourceEvent) => void;
}

export interface NativeBuildContextOptions {
	runtimeDirectory?: string;
	/** Root for all reusable native artifacts. Defaults to the shared user cache. */
	cacheDirectory?: string;
	features?: NativeFeatureInput | NativeFeatureSpec;
	toolchain?: Toolchain;
	/** The release producer uses Zig's Clang driver for already-preprocessed C. */
	runtimeObjectCompiler?: ToolExecutable;
	plan?: NativeBuildPlan;
	production?: boolean;
	/** Rust target triple. Explicit targets are cross-built through Zig. */
	target?: string;
	compilerBake?: CompilerBakeInput;
	/** Environment snapshot used for discovery and all native subprocesses. */
	environment?: NodeJS.ProcessEnv;
	onCacheEvent?: (event: BuildCacheEvent) => void;
	onBuildPhase?: (event: NativeBuildPhaseEvent) => void;
	onCommand?: (event: NativeBuildCommandEvent) => void;
	measureCommandResources?: boolean;
	onCommandResource?: (event: NativeBuildCommandResourceEvent) => void;
}

const BUILD_ENVIRONMENT_NAMES = new Set([
	"AR",
	"ARCHS",
	"CC",
	"CC_KNOWN_WRAPPER_CUSTOM",
	"CFLAGS",
	"CPPFLAGS",
	"CPATH",
	"CRATE_CC_NO_DEFAULTS",
	"CXX",
	"CXXFLAGS",
	"C_INCLUDE_PATH",
	"CPLUS_INCLUDE_PATH",
	"DEVELOPER_DIR",
	"IPHONEOS_DEPLOYMENT_TARGET",
	"LDFLAGS",
	"LD",
	"LIBRARY_PATH",
	"MACOSX_DEPLOYMENT_TARGET",
	"NM",
	"OBJC",
	"PATH",
	"PKG_CONFIG_PATH",
	"RANLIB",
	"RUSTC",
	"RUSTC_WORKSPACE_WRAPPER",
	"RUSTC_WRAPPER",
	"RUSTDOCFLAGS",
	"RUSTFLAGS",
	"RUSTUP_HOME",
	"RUSTUP_TOOLCHAIN",
	"SDKROOT",
	"STRIP",
	"SYSROOT",
	"ZIG",
]);

function isCargoBuildVariable(name: string): boolean {
	return (
		name === "CARGO_BUILD_TARGET" ||
		name === "CARGO_ENCODED_RUSTFLAGS" ||
		name === "CARGO_INCREMENTAL" ||
		name.startsWith("CARGO_PROFILE_") ||
		(name.startsWith("CARGO_TARGET_") && name !== "CARGO_TARGET_DIR")
	);
}

/**
 * npm and npx prepend package-binary directories (every ancestor `node_modules/.bin`
 * and npm's `node-gyp-bin`). They hold JavaScript package shims, never native build
 * tools, so a build launched through npm and one launched by `node` share artifacts.
 */
function nativeSearchPath(value: string): string {
	const npmGypBin = path.join("@npmcli", "run-script", "lib", "node-gyp-bin");
	return [
		...new Set(
			value
				.split(path.delimiter)
				.filter(
					(entry) =>
						!(
							path.basename(entry) === ".bin" &&
							path.basename(path.dirname(entry)) === "node_modules"
						) && !entry.endsWith(npmGypBin),
				),
		),
	].join(path.delimiter);
}

/** Stable projection of build-affecting native variables without unrelated secrets. */
export function nativeBuildEnvironmentFingerprint(env: NodeJS.ProcessEnv): string {
	const filtered = Object.entries(env)
		.filter(
			([name, value]) =>
				value !== undefined &&
				(BUILD_ENVIRONMENT_NAMES.has(name) || isCargoBuildVariable(name)),
		)
		.map(
			([name, value]) =>
				[
					name,
					name === "PATH" && value !== undefined ? nativeSearchPath(value) : value,
				] as const,
		)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return hash("sha256", JSON.stringify(filtered), "hex");
}

function withMacosDeploymentTarget(
	toolchain: Toolchain,
	environment: NodeJS.ProcessEnv,
	production: boolean,
): Toolchain {
	const version =
		environment.MACOSX_DEPLOYMENT_TARGET ||
		(production ? RELEASE_MACOS_VERSION : undefined);
	if (
		toolchain.cross !== true ||
		toolchain.platform !== "darwin" ||
		toolchain.zigTarget?.includes(".") ||
		!version
	)
		return toolchain;

	// Zig forwards preprocessed C to Clang, which needs the deployment flag for
	// its unversioned Darwin target to support thread-local storage.
	const flag = `-mmacosx-version-min=${version}`;
	const withFlag = (tool: ToolExecutable): ToolExecutable => ({
		...tool,
		args: [...(tool.args ?? []), flag],
	});
	const fingerprint = (base: string): string =>
		hash("sha256", JSON.stringify([base, flag]), "hex");
	return {
		...toolchain,
		tools: {
			...toolchain.tools,
			cc: withFlag(toolchain.tools.cc),
			cxx: toolchain.tools.cxx === undefined ? undefined : withFlag(toolchain.tools.cxx),
		},
		fingerprint: fingerprint(toolchain.fingerprint),
		ccFingerprint: fingerprint(toolchain.ccFingerprint),
	};
}

export function nativeToolchainOptions(
	runtimeDirectory: string,
	options: InspectToolchainOptions = {},
	zigFallbackMode?: "install" | "report",
): InspectToolchainOptions {
	const environment = options.env ?? process.env;
	const cacheDirectory = maligatorCacheDirectory(options.cacheDirectory, environment);
	const target =
		options.target ??
		nativeRustTarget(options.platform ?? process.platform, options.arch ?? process.arch);
	const bundle =
		target === undefined
			? undefined
			: packagedRuntimeRust({ runtimeDirectory, environment, cacheDirectory }, target);
	return {
		...options,
		cacheDirectory,
		rustDir: path.join(runtimeDirectory, "rust"),
		prebuiltRustTarget: bundle === undefined ? undefined : target,
		...(zigFallbackMode === undefined
			? {}
			: { zigFallback: options.zigFallback ?? { mode: zigFallbackMode } }),
	};
}

/** Resolve native defaults once and freeze the values consumed by every backend stage. */
export function resolveNativeBuildContext(
	options: NativeBuildContextOptions = {},
): NativeBuildContext {
	const runtimeDirectory = path.resolve(options.runtimeDirectory ?? "runtime");
	const baseEnvironment = options.environment ?? process.env;
	const cacheDirectory = maligatorCacheDirectory(options.cacheDirectory, baseEnvironment);
	const normalizedFeatures =
		options.features === undefined
			? normalizeNativeFeatures()
			: normalizeNativeFeatures(options.features);
	const features = Object.freeze({
		...normalizedFeatures,
		intlFeatures: Object.freeze([...normalizedFeatures.intlFeatures]),
		cDefines: Object.freeze([...normalizedFeatures.cDefines]),
		cargoFeatures: Object.freeze([...normalizedFeatures.cargoFeatures]),
	}) as Readonly<NativeFeatureSpec>;
	const production =
		options.plan === undefined
			? options.production === true
			: options.plan.mode === "production";
	const inspection = {
		cacheDirectory,
		env: baseEnvironment,
		needsCxx: production || features.cargoFeatures.includes("url"),
		target: options.target,
	};
	const selectedToolchain =
		options.toolchain ??
		requireToolchain(
			nativeToolchainOptions(
				runtimeDirectory,
				inspection,
				production ? "install" : undefined,
			),
		);
	const toolchain = withMacosDeploymentTarget(
		selectedToolchain,
		baseEnvironment,
		production,
	);
	const environment = Object.freeze({
		...baseEnvironment,
		...(toolchain.environmentOverrides ?? {}),
	});
	const selectedPlan = options.plan ?? selectNativeBuildPlan(toolchain, production);
	const plan = Object.freeze({
		...selectedPlan,
		ltoFlags: Object.freeze([...selectedPlan.ltoFlags]),
		warnings: Object.freeze([...selectedPlan.warnings]),
	}) as NativeBuildPlan;
	const compilerBake =
		options.compilerBake === undefined
			? undefined
			: Object.freeze({
					...options.compilerBake,
					cacheRoot: path.join(cacheDirectory, "compiler-wire"),
				});

	return Object.freeze({
		runtimeDirectory,
		cacheDirectory,
		features,
		toolchain,
		runtimeObjectCompiler: options.runtimeObjectCompiler,
		plan,
		compilerBake,
		environment,
		environmentFingerprint: nativeBuildEnvironmentFingerprint(environment),
		onCacheEvent: options.onCacheEvent,
		onBuildPhase: options.onBuildPhase,
		onCommand: options.onCommand,
		measureCommandResources: options.measureCommandResources ?? false,
		onCommandResource: options.onCommandResource,
	});
}
