import { hash } from "node:crypto";
import * as path from "node:path";
import { normalizeNativeFeatures, selectNativeBuildPlan } from "./build-flags.ts";
import type {
	NativeBuildPlan,
	NativeFeatureInput,
	NativeFeatureSpec,
} from "./build-flags.ts";
import type { CompilerBakeInput } from "./compiler-bake.ts";
import { requireToolchain } from "./toolchain.ts";
import type { Toolchain } from "./toolchain.ts";

export interface BuildCacheEvent {
	artifact: "runtime" | "rust";
	hit: boolean;
	path: string;
}

export interface NativeBuildPhaseEvent {
	phase:
		| "runtime"
		| "rust"
		| "write generated C"
		| "generated C objects"
		| "link"
		| "strip";
	durationMs: number;
	cache?: "hit" | "miss";
	path?: string;
}

export interface NativeBuildCommandEvent {
	tool: string;
	args: ReadonlyArray<string>;
	cwd?: string;
}

/** Every resolved input shared by the C archive, Rust archive, and final linker. */
export interface NativeBuildContext {
	readonly runtimeDirectory: string;
	readonly cacheDirectory: string;
	readonly features: Readonly<NativeFeatureSpec>;
	readonly toolchain: Toolchain;
	readonly plan: NativeBuildPlan;
	readonly compilerBake?: Readonly<CompilerBakeInput>;
	readonly environment: Readonly<NodeJS.ProcessEnv>;
	readonly environmentFingerprint: string;
	readonly onCacheEvent?: (event: BuildCacheEvent) => void;
	readonly onBuildPhase?: (event: NativeBuildPhaseEvent) => void;
	readonly onCommand?: (event: NativeBuildCommandEvent) => void;
}

export interface NativeBuildContextOptions {
	runtimeDirectory?: string;
	/** Root for all reusable native artifacts. Defaults to project `.cache/mal-cache`. */
	cacheDirectory?: string;
	features?: NativeFeatureInput | NativeFeatureSpec;
	toolchain?: Toolchain;
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

/** Stable projection of build-affecting native variables without unrelated secrets. */
export function nativeBuildEnvironmentFingerprint(env: NodeJS.ProcessEnv): string {
	const filtered = Object.entries(env)
		.filter(
			([name, value]) =>
				value !== undefined &&
				(BUILD_ENVIRONMENT_NAMES.has(name) || isCargoBuildVariable(name)),
		)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return hash("sha256", JSON.stringify(filtered), "hex");
}

/** Resolve native defaults once and freeze the values consumed by every backend stage. */
export function resolveNativeBuildContext(
	options: NativeBuildContextOptions = {},
): NativeBuildContext {
	const runtimeDirectory = path.resolve(options.runtimeDirectory ?? "runtime");
	const cacheDirectory = path.resolve(options.cacheDirectory ?? ".cache/mal-cache");
	const baseEnvironment = options.environment ?? process.env;
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
	const toolchain =
		options.toolchain ??
		requireToolchain({
			env: baseEnvironment,
			needsCxx: features.webPlatformEnabled,
			rustDir: path.join(runtimeDirectory, "rust"),
			target: options.target,
		});
	const environment = Object.freeze({
		...baseEnvironment,
		...(toolchain.environmentOverrides ?? {}),
	});
	const selectedPlan =
		options.plan ?? selectNativeBuildPlan(toolchain, options.production ?? false);
	const plan = Object.freeze({
		...selectedPlan,
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
		plan,
		compilerBake,
		environment,
		environmentFingerprint: nativeBuildEnvironmentFingerprint(environment),
		onCacheEvent: options.onCacheEvent,
		onBuildPhase: options.onBuildPhase,
		onCommand: options.onCommand,
	});
}
