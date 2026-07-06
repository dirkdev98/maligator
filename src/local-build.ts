import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { buildSuffix, ccExtraFlags, cmakeCFlags } from "./build-flags.ts";
import { ensureCompilerWire } from "./compiler-bake.ts";
import { ensureRustLibrary, RUST_INCLUDE_DIR, rustLinkArgs } from "./rust-build.ts";

const LOCAL_DIR = ".cache/local";

/**
 * A sanitizer / generational / eval-disabled build gets its own build dir +
 * binaries so toggling a dimension does not force a full reconfigure/rebuild of
 * the normal -O2 archive (CMAKE_C_FLAGS is cached per build dir). `cacheSuffix` is
 * the build-config hash (build-config.ts); empty == the default eval-on build.
 */
function buildDirFor(cacheSuffix: string): string {
	return path.join(LOCAL_DIR, `lib${buildSuffix(cacheSuffix)}`);
}

/** The build dimensions that select a distinct cached archive. */
interface RuntimeBuildDimensions {
	/** Whether to embed the baked compiler + allow eval/Function. Default true. */
	evalEnabled?: boolean;
	/** Build-config hash suffix (build-config.ts). Default "" (eval-on archive). */
	cacheSuffix?: string;
}

export interface LocalBuildOptions {
	/**
	 * Base name for the emitted `.c` and the linked binary under `.cache/local`.
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
	 * Directory for the emitted `.c` and linked binary. Defaults to `.cache/local`.
	 * The vitest native lane passes a per-test temp dir so parallel workers do not
	 * clobber each other's artifacts (the shared runtime archives stay cached under
	 * `.cache/local/lib` regardless).
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
	 * Build-config hash (build-config.ts `buildConfigCacheSuffix`) selecting which
	 * cached archive/build dir this binary links against. Defaults to "" (the
	 * eval-on archive). Must be consistent with {@link evalEnabled}.
	 */
	cacheSuffix?: string;
}

/**
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
	const evalEnabled = dimensions.evalEnabled ?? true;
	const cacheSuffix = dimensions.cacheSuffix ?? "";
	const buildDir = buildDirFor(cacheSuffix);
	const stdio = verbose ? "inherit" : "ignore";

	mkdirSync(LOCAL_DIR, { recursive: true });

	// Generate the baked compiler wire (runtime/src/compiler.malw) before cmake:
	// the GLOB pulls in compiler_wire.c, whose `#embed` needs the file to exist.
	// Skipped for an eval-disabled build — the `#embed` is guarded out by
	// `-DMAL_EVAL=0`, so the file is never referenced (faster build, no bake).
	if (evalEnabled) {
		ensureCompilerWire(verbose);
	}

	// Re-running configure with unchanged cache variables is cheap.
	execFileSync(
		"cmake",
		["-S", "runtime", "-B", buildDir, `-DCMAKE_C_FLAGS=${cmakeCFlags({ evalEnabled })}`],
		{
			stdio,
		},
	);

	execFileSync(
		"cmake",
		["--build", buildDir, "--target", "LibMaligator", "MalHost", "MalRuntime"],
		{ stdio },
	);

	// Build the Rust shim the runtime links against: Date tz + Intl (ICU4X) and
	// the RegExp engine (regress), both in libmal_rust.a.
	ensureRustLibrary(verbose);

	// Link order: runtime -> host -> engine (dependents first). rustLinkArgs() is
	// appended after these by the caller (the engine references its symbols).
	return runtimeArchivePaths(buildDir);
}

/**
 * Build the `MaligatorLoad` dev driver: it loads a serialized definition (.malw,
 * the serialize-vm.ts wire format) into a fresh VM and runs it. Used to validate
 * the C loader (mal_vm_load_definition) against the C-baked path. Returns the
 * binary path.
 */
export function buildLoadDriver(verbose: boolean): string {
	const libs = ensureRuntimeLibrary(verbose);
	const binPath = path.join(LOCAL_DIR, `MaligatorLoad${buildSuffix()}`);

	execFileSync(
		"cc",
		[
			"-std=c2x",
			...ccExtraFlags(),
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
			...rustLinkArgs(),
			"-o",
			binPath,
		],
		{ stdio: verbose ? "inherit" : "ignore" },
	);

	return binPath;
}

/**
 * Compile and link an emitted definition into a standalone runnable binary at
 * `.cache/local/<name>`, reusing the test262 harness main as the entry point.
 * Returns the path to the binary.
 */
export function buildLocalBinary(options: LocalBuildOptions): string {
	const evalEnabled = options.evalEnabled ?? true;
	const cacheSuffix = options.cacheSuffix ?? "";
	const libs = options.skipRuntimeBuild
		? runtimeArchivePaths(buildDirFor(cacheSuffix))
		: ensureRuntimeLibrary(options.verbose, { evalEnabled, cacheSuffix });

	// Suffix the artifacts under a sanitizer / eval-disabled build so they do not
	// clobber the normal binary (and vice-versa).
	const artifactName = `${options.name}${buildSuffix(cacheSuffix)}`;
	const outDir = options.outDir ?? LOCAL_DIR;
	mkdirSync(outDir, { recursive: true });
	const cPath = path.join(outDir, `${artifactName}.c`);
	const binPath = path.join(outDir, artifactName);
	writeFileSync(cPath, options.cSource);

	execFileSync(
		"cc",
		[
			"-std=c2x",
			...ccExtraFlags(),
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
			...rustLinkArgs(),
			"-o",
			binPath,
		],
		{ stdio: options.verbose ? "inherit" : "ignore" },
	);

	return binPath;
}
