import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { buildSuffix, ccExtraFlags, cmakeCFlags } from "./build-flags.ts";
import { ensureCompilerWire } from "./compiler-bake.ts";
import { ensureRustLibrary, RUST_INCLUDE_DIR, rustLinkArgs } from "./rust-build.ts";

const LOCAL_DIR = ".cache/local";
// A sanitizer build gets its own build dir + binaries so toggling MAL_ASAN /
// MAL_UBSAN does not force a full reconfigure/rebuild of the normal -O2 archive
// (CMAKE_C_FLAGS is cached per build dir). Empty suffix == the normal build.
const BUILD_DIR = path.join(LOCAL_DIR, `lib${buildSuffix()}`);

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
}

/**
 * Configure and build the three runtime archives (engine / host / runtime) into a
 * local build directory at -O2. Returns their static-archive paths in link order
 * (dependents first: runtime, host, engine — so a later archive resolves an earlier
 * one's references), which the final cc links together (static + optimized).
 */
function ensureRuntimeLibrary(verbose: boolean): Array<string> {
	const stdio = verbose ? "inherit" : "ignore";

	mkdirSync(LOCAL_DIR, { recursive: true });

	// Generate the baked compiler wire (runtime/src/compiler.malw) before cmake:
	// the GLOB pulls in compiler_wire.c, whose `#embed` needs the file to exist.
	ensureCompilerWire(verbose);

	// Re-running configure with unchanged cache variables is cheap.
	execFileSync(
		"cmake",
		["-S", "runtime", "-B", BUILD_DIR, `-DCMAKE_C_FLAGS=${cmakeCFlags()}`],
		{
			stdio,
		},
	);

	execFileSync(
		"cmake",
		["--build", BUILD_DIR, "--target", "LibMaligator", "MalHost", "MalRuntime"],
		{ stdio },
	);

	// Build the Rust shim the runtime links against: Date tz + Intl (ICU4X) and
	// the RegExp engine (regress), both in libmal_rust.a.
	ensureRustLibrary(verbose);

	// Link order: runtime -> host -> engine (dependents first). rustLinkArgs() is
	// appended after these by the caller (the engine references its symbols).
	return [
		path.join(BUILD_DIR, "libMalRuntime.a"),
		path.join(BUILD_DIR, "libMalHost.a"),
		path.join(BUILD_DIR, "libLibMaligator.a"),
	];
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
	const libs = ensureRuntimeLibrary(options.verbose);

	// Suffix the artifacts under a sanitizer build so they do not clobber the
	// normal binary (and vice-versa).
	const artifactName = `${options.name}${buildSuffix()}`;
	const cPath = path.join(LOCAL_DIR, `${artifactName}.c`);
	const binPath = path.join(LOCAL_DIR, artifactName);
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
