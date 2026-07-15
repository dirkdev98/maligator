import { execFileSync } from "node:child_process";
import { hash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
	buildSuffix,
	ccExtraFlags,
	cmakeCFlags,
	featureDefines,
	selectNativeBuildPlan,
} from "./build-flags.ts";
import type { NativeBuildPlan } from "./build-flags.ts";
import { ensureCompilerWire } from "./compiler-bake.ts";
import type { CompilerBakeOptions } from "./compiler-bake.ts";
import { ensureRustLibrary, RUST_INCLUDE_DIR, rustLinkArgs } from "./rust-build.ts";
import { requireToolchain } from "./toolchain.ts";
import type { Toolchain } from "./toolchain.ts";

const BUILD_DIR = ".cache/mal-build";
const RUNTIME_CACHE_DIR = ".cache/mal-cache/runtime";

export interface BuildCacheEvent {
	artifact: "runtime" | "rust";
	hit: boolean;
	path: string;
}

let runtimeSourcesHash: string | undefined;
const runtimeBuildDirs = new Map<string, string>();

function runtimeSourceHash(): string {
	if (runtimeSourcesHash !== undefined) return runtimeSourcesHash;
	const parts: Array<string> = [];
	const collect = (filePath: string): void => {
		parts.push(
			filePath,
			"\0",
			hash("sha256", readFileSync(filePath, "utf-8"), "hex"),
			"\0",
		);
	};
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			const full = path.join(directory, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (/\.[ch]$/.test(entry.name)) collect(full);
		}
	};
	collect("runtime/CMakeLists.txt");
	walk("runtime/src");
	walk("runtime/rust/include");
	runtimeSourcesHash = hash("sha256", parts.join(""), "hex");
	return runtimeSourcesHash;
}

export function runtimeArtifactKey(inputs: {
	cacheSuffix: string;
	compilerWire?: string;
	flags: string;
	mode: NativeBuildPlan["mode"];
	sourceHash: string;
	toolchainFingerprint: string;
	target: string;
}): string {
	return hash("sha256", JSON.stringify({ schema: 2, ...inputs }), "hex").slice(0, 24);
}

/** The build dimensions that select a distinct cached archive. */
interface RuntimeBuildDimensions {
	/** Preflighted native toolchain shared with doctor. */
	toolchain?: Toolchain;
	/** Whether to embed the baked compiler + allow eval/Function. Default true. */
	evalEnabled?: boolean;
	/** Whether to compile the Realm surface (`-DMAL_REALMS`). Default true. */
	realmsEnabled?: boolean;
	/** Whether to link the Intl (ICU4X) surface. Default true. */
	intlEnabled?: boolean;
	/** `-DMAL_INTL_HAS_<SERVICE>=0` cc defines for dropped Intl services (subset build). */
	intlServiceDefines?: Array<string>;
	/** Per-service Rust Cargo features (`intl-collator`, …) for a subset Intl build. */
	intlFeatures?: Array<string>;
	/** Whether to compile the WHATWG URL (ada) surface (`web-platform`). Default true. */
	webPlatformEnabled?: boolean;
	/** Whether to compile the RegExp engine (regress / `regexp` feature). Default true. */
	regexpEnabled?: boolean;
	/** Whether to enable the node host built-in surface (`-DMAL_NODE=1`). Default false. */
	nodeEnabled?: boolean;
	/** C-build-config hash suffix (build-config.ts). Default "" (canonical archive). */
	cacheSuffix?: string;
	/** Rust/Intl-config hash suffix selecting the ICU archive. Default "" (all services). */
	rustCacheSuffix?: string;
	/** Explicit eval compiler input; required when the checked-in wire is stale. */
	compilerBake?: CompilerBakeOptions;
	/** One plan shared by archive compilation and the final compile/link. */
	plan?: NativeBuildPlan;
	onCacheEvent?: (event: BuildCacheEvent) => void;
}

export interface LocalBuildOptions {
	/** Preflighted native toolchain; discovered automatically when omitted. */
	toolchain?: Toolchain;
	/**
	 * Base name for the emitted `.c` and linked binary under `.cache/mal-build`.
	 */
	name: string;

	/**
	 * Emitted translation unit (must already include `vm.h`).
	 */
	cSource: string;

	/**
	 * Surface cmake/cc output instead of swallowing it.
	 */
	verbose: boolean;

	/**
	 * Entry-point translation unit linked with the emitted definition. Defaults to
	 * the test262 harness main; a custom driver (e.g. the fiber test) overrides it.
	 */
	mainFile?: string;

	/**
	 * Directory for the emitted `.c` and linked binary. Defaults to `.cache/mal-build`.
	 * The vitest native lane passes a per-test temp dir so parallel workers do not
	 * clobber each other's artifacts (the shared runtime archives stay cached under
	 * `.cache/mal-cache/runtime` regardless).
	 */
	outDir?: string;

	/**
	 * Link against already-built runtime archives instead of (re)building them.
	 * The vitest native lane sets this after globalSetup has built them once, so
	 * parallel workers only emit + link and never race a shared `cmake`.
	 */
	skipRuntimeBuild?: boolean;

	/**
	 * Whether this binary includes runtime eval / new Function (embeds the 1.6 MB
	 * baked compiler). Defaults to true (the eval-on archive). Set false for an
	 * `engine.eval: false` build: no compiler embed, `-DMAL_EVAL=0`, and its own
	 * cached archive keyed by {@link cacheSuffix}.
	 */
	evalEnabled?: boolean;

	/**
	 * Whether this binary compiles the Realm surface. Defaults to true. Set false for
	 * an `engine.realms: false` build: `-DMAL_REALMS=0` on the C side and its own
	 * cached archive keyed by {@link cacheSuffix}.
	 */
	realmsEnabled?: boolean;

	/**
	 * Whether this binary includes the Intl (ICU4X) surface. Defaults to true. Set
	 * false for an `engine.intl: false` build: `-DMAL_INTL=0` on the C side and the
	 * `--no-default-features` ICU-less Rust archive keyed by {@link rustCacheSuffix}.
	 */
	intlEnabled?: boolean;

	/** `-DMAL_INTL_HAS_<SERVICE>=0` cc defines for dropped Intl services (subset). */
	intlServiceDefines?: Array<string>;

	/** Per-service Rust Cargo features (`intl-collator`, …) for a subset Intl build. */
	intlFeatures?: Array<string>;

	/**
	 * Whether this binary includes the WHATWG URL (ada) surface. Defaults to true.
	 * Set false for a `surface.webPlatform: false` build: `-DMAL_WEB_PLATFORM=0` on
	 * the C side (url.c compiles away), the `--no-default-features` ada-less Rust
	 * archive keyed by {@link rustCacheSuffix}, and no `-lc++` at link.
	 */
	webPlatformEnabled?: boolean;

	/**
	 * Whether this binary includes the RegExp engine (regress). Defaults to true. Set
	 * false for an `engine.regexp: false` build: `-DMAL_REGEXP=0` on the C side
	 * (builtin_regexp.c/regexp_object.c compile away, String regex methods throw) and
	 * the regress-less Rust archive keyed by {@link rustCacheSuffix}.
	 */
	regexpEnabled?: boolean;

	/**
	 * Whether this binary includes the node host built-in surface (`surface.node`).
	 * Defaults to FALSE (product default) — unlike the features above, node is
	 * opt-in: `-DMAL_NODE=1` on the C side and its own cached archive keyed by
	 * {@link cacheSuffix}. No Rust dimension (node adds no Rust deps).
	 */
	nodeEnabled?: boolean;

	/**
	 * C-build-config hash (build-config.ts `buildConfigCacheSuffix`) selecting the
	 * C build dir / archive. Defaults to "" (canonical). Consistent with
	 * {@link evalEnabled} + {@link intlEnabled}.
	 */
	cacheSuffix?: string;

	/**
	 * Rust/Intl-config hash (build-config.ts `rustConfigCacheSuffix`) selecting the
	 * ICU archive to link. Defaults to "" (Intl on, all locales). Keyed on the Intl
	 * axis only, so toggling eval does not rebuild ICU.
	 */
	rustCacheSuffix?: string;

	/** Explicit eval compiler bytes or a Node-hosted in-process bake callback. */
	compilerBake?: CompilerBakeOptions;
	/** One plan shared by archive compilation and the final compile/link. */
	plan?: NativeBuildPlan;
	onCacheEvent?: (event: BuildCacheEvent) => void;
	onWarning?: (message: string) => void;
}

/**
 * The three runtime archives in link order (dependents first: runtime, host,
 * engine — so a later archive resolves an earlier one's references), WITHOUT
 * building them. Callers that pass `skipRuntimeBuild` (the vitest native lane,
 * after globalSetup has built them once) link against these directly; a
 * concurrent `cmake` would otherwise race on the shared build dir.
 */
function runtimeArchivePaths(buildDir: string): Array<string> {
	return [
		path.join(buildDir, "libMalRuntime.a"),
		path.join(buildDir, "libMalHost.a"),
		path.join(buildDir, "libLibMaligator.a"),
	];
}

function runtimeLayout(dimensions: RuntimeBuildDimensions): {
	buildDir: string;
	flags: string;
	toolchain: Toolchain;
	plan: NativeBuildPlan;
} {
	const evalEnabled = dimensions.evalEnabled ?? true;
	const webPlatformEnabled = dimensions.webPlatformEnabled ?? true;
	const toolchain =
		dimensions.toolchain ?? requireToolchain({ needsCxx: webPlatformEnabled });
	const plan = dimensions.plan ?? selectNativeBuildPlan(toolchain, false);
	const compilerWire = evalEnabled
		? ensureCompilerWire(dimensions.compilerBake)
		: undefined;
	const flags = [
		cmakeCFlags(
			{
				evalEnabled,
				realmsEnabled: dimensions.realmsEnabled ?? true,
				intlEnabled: dimensions.intlEnabled ?? true,
				intlServiceDefines: dimensions.intlServiceDefines ?? [],
				webPlatformEnabled,
				regexpEnabled: dimensions.regexpEnabled ?? true,
				nodeEnabled: dimensions.nodeEnabled ?? false,
			},
			plan,
		),
		...(compilerWire === undefined ? [] : [`-DMAL_COMPILER_WIRE=\\"${compilerWire}\\"`]),
	].join(" ");
	const key = runtimeArtifactKey({
		cacheSuffix: dimensions.cacheSuffix ?? "",
		compilerWire:
			compilerWire === undefined ? undefined : path.basename(path.dirname(compilerWire)),
		flags,
		mode: plan.mode,
		sourceHash: runtimeSourceHash(),
		toolchainFingerprint: toolchain.fingerprint,
		target: toolchain.target,
	});
	return {
		buildDir: path.join(RUNTIME_CACHE_DIR, key),
		flags,
		toolchain,
		plan,
	};
}

/**
 * The three runtime archive paths for a C-build-config suffix, named so the size
 * bench can stat the archives matching each matrix config ("" = the canonical
 * build dir). The single source of truth for the per-suffix archive locations.
 */
export function localRuntimeArchivePaths(cacheSuffix = ""): {
	runtime: string;
	host: string;
	engine: string;
} {
	const buildDir =
		runtimeBuildDirs.get(`development:${cacheSuffix}`) ??
		runtimeLayout({ cacheSuffix }).buildDir;
	const [runtime, host, engine] = runtimeArchivePaths(buildDir);
	return { runtime: runtime!, host: host!, engine: engine! };
}

/**
 * Configure and build the three runtime archives (engine / host / runtime) into a
 * local build directory at -O2. Returns their static-archive paths in link order,
 * which the final cc links together (static + optimized). Exported so the vitest
 * native lane can build them ONCE in globalSetup before parallel workers link.
 */
export function ensureRuntimeLibrary(
	verbose: boolean,
	dimensions: RuntimeBuildDimensions = {},
): Array<string> {
	const intlEnabled = dimensions.intlEnabled ?? true;
	const intlFeatures = dimensions.intlFeatures ?? [];
	const webPlatformEnabled = dimensions.webPlatformEnabled ?? true;
	const regexpEnabled = dimensions.regexpEnabled ?? true;
	const rustCacheSuffix = dimensions.rustCacheSuffix ?? "";
	const { buildDir, flags, toolchain, plan } = runtimeLayout(dimensions);
	runtimeBuildDirs.set(`${plan.mode}:${dimensions.cacheSuffix ?? ""}`, buildDir);
	const stdio = verbose ? "inherit" : "pipe";
	const archives = runtimeArchivePaths(buildDir);
	const cacheHit = archives.every((archive) => existsSync(archive));
	dimensions.onCacheEvent?.({ artifact: "runtime", hit: cacheHit, path: buildDir });
	if (!cacheHit) {
		mkdirSync(buildDir, { recursive: true });
		execFileSync(
			toolchain.tools.cmake.path,
			[
				"-S",
				"runtime",
				"-B",
				buildDir,
				`-DCMAKE_C_COMPILER=${toolchain.tools.cc.path}`,
				`-DCMAKE_AR=${toolchain.tools.ar.path}`,
				...(toolchain.tools.cxx === undefined
					? []
					: [`-DCMAKE_CXX_COMPILER=${toolchain.tools.cxx.path}`]),
				`-DCMAKE_C_FLAGS=${flags}`,
			],
			{ stdio },
		);

		execFileSync(
			toolchain.tools.cmake.path,
			["--build", buildDir, "--target", "LibMaligator", "MalHost", "MalRuntime"],
			{ stdio },
		);
	}

	// Build the Rust shim the runtime links against: Date tz (jiff) + the RegExp
	// engine (regress), always; Intl (ICU4X) and the URL (ada) parser by feature.
	// Intl-off drops the ICU crates, web-off drops ada; the archive is keyed by
	// rustCacheSuffix so variants coexist.
	ensureRustLibrary(
		verbose,
		{
			intlEnabled,
			features: intlFeatures,
			webPlatform: webPlatformEnabled,
			regexp: regexpEnabled,
			cacheSuffix: rustCacheSuffix,
		},
		toolchain,
		plan,
		(event) => dimensions.onCacheEvent?.(event),
	);

	// Link order: runtime -> host -> engine (dependents first). rustLinkArgs() is
	// appended after these by the caller (the engine references its symbols).
	return archives;
}

/**
 * Build the `MaligatorLoad` dev driver: it loads a serialized definition (.malw,
 * the serialize-vm.ts wire format) into a fresh VM and runs it. Used to validate
 * the C loader (mal_vm_load_definition) against the C-baked path. Returns the
 * binary path.
 */
export function buildLoadDriver(
	verbose: boolean,
	compilerBake?: CompilerBakeOptions,
): string {
	const toolchain = requireToolchain({ needsCxx: true });
	const plan = selectNativeBuildPlan(toolchain, false);
	const libs = ensureRuntimeLibrary(verbose, { compilerBake, toolchain, plan });
	const binPath = path.join(BUILD_DIR, plan.mode, `MaligatorLoad${buildSuffix()}`);
	mkdirSync(path.dirname(binPath), { recursive: true });

	execFileSync(
		toolchain.tools.cc.path,
		[
			"-std=c2x",
			...ccExtraFlags(plan),
			"-I",
			"runtime/src",
			"-I",
			"runtime/src/host",
			"-I",
			"runtime/src/runtime",
			"-I",
			RUST_INCLUDE_DIR,
			"runtime/load_main.c",
			...libs,
			...rustLinkArgs("", true, toolchain.probes.cxxLinkArgs, toolchain, plan),
			"-o",
			binPath,
		],
		{ stdio: verbose ? "inherit" : "pipe" },
	);

	return binPath;
}

/**
 * Compile and link an emitted definition into a standalone runnable binary at
 * `.cache/mal-build/<mode>/<name>`, reusing the test262 harness main as the entry point.
 * Returns the path to the binary.
 */
export function buildLocalBinary(options: LocalBuildOptions): string {
	const evalEnabled = options.evalEnabled ?? true;
	const realmsEnabled = options.realmsEnabled ?? true;
	const intlEnabled = options.intlEnabled ?? true;
	const webPlatformEnabled = options.webPlatformEnabled ?? true;
	const regexpEnabled = options.regexpEnabled ?? true;
	const nodeEnabled = options.nodeEnabled ?? false;
	const toolchain =
		options.toolchain ?? requireToolchain({ needsCxx: webPlatformEnabled });
	const plan = options.plan ?? selectNativeBuildPlan(toolchain, false);
	const cacheSuffix = options.cacheSuffix ?? "";
	const rustCacheSuffix = options.rustCacheSuffix ?? "";
	const dimensions: RuntimeBuildDimensions = {
		evalEnabled,
		realmsEnabled,
		intlEnabled,
		intlServiceDefines: options.intlServiceDefines,
		intlFeatures: options.intlFeatures,
		webPlatformEnabled,
		regexpEnabled,
		nodeEnabled,
		toolchain,
		cacheSuffix,
		rustCacheSuffix,
		compilerBake: options.compilerBake,
		plan,
		onCacheEvent: options.onCacheEvent,
	};
	const libs = options.skipRuntimeBuild
		? runtimeArchivePaths(runtimeLayout(dimensions).buildDir)
		: ensureRuntimeLibrary(options.verbose, {
				...dimensions,
			});

	// Suffix the artifacts under a sanitizer / eval-disabled build so they do not
	// clobber the normal binary (and vice-versa).
	const artifactName = `${options.name}${buildSuffix(cacheSuffix)}`;
	const outDir = options.outDir ?? path.join(BUILD_DIR, plan.mode);
	mkdirSync(outDir, { recursive: true });
	const cPath = path.join(outDir, `${artifactName}.c`);
	const binPath = path.join(outDir, artifactName);
	writeFileSync(cPath, options.cSource);

	execFileSync(
		toolchain.tools.cc.path,
		[
			"-std=c2x",
			...ccExtraFlags(plan),
			// The entry driver (host_main.c) gates its web installs on MAL_WEB_PLATFORM;
			// it must compile with the same feature defines as the archive it links.
			...featureDefines({
				evalEnabled,
				realmsEnabled,
				intlEnabled,
				intlServiceDefines: options.intlServiceDefines,
				webPlatformEnabled,
				regexpEnabled,
				nodeEnabled,
			}),
			"-I",
			"runtime/src",
			"-I",
			"runtime/src/host",
			"-I",
			"runtime/src/runtime",
			"-I",
			RUST_INCLUDE_DIR,
			cPath,
			options.mainFile ?? "runtime/test262_main.c",
			...libs,
			...rustLinkArgs(
				rustCacheSuffix,
				webPlatformEnabled,
				toolchain.probes.cxxLinkArgs,
				toolchain,
				plan,
			),
			"-o",
			binPath,
		],
		{ stdio: options.verbose ? "inherit" : "pipe" },
	);
	if (plan.strip && toolchain.tools.strip !== undefined) {
		try {
			execFileSync(toolchain.tools.strip.path, [...toolchain.probes.stripArgs, binPath], {
				stdio: options.verbose ? "inherit" : "pipe",
			});
		} catch (error) {
			options.onWarning?.(
				`production symbol stripping failed after a successful probe; leaving the binary unstripped: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	return binPath;
}
