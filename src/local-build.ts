import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { ensureI18nLibrary, I18N_INCLUDE_DIR, i18nLinkArgs } from "./i18n-build.ts";

const LOCAL_DIR = ".cache/local";
const BUILD_DIR = path.join(LOCAL_DIR, "lib");
const OPT = "-O2";

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
}

/**
 * Configure and build LibMaligator into a local build directory at -O2.
 * Returns the path to the resulting static archive.
 */
function ensureRuntimeLibrary(verbose: boolean): string {
	const stdio = verbose ? "inherit" : "ignore";

	mkdirSync(LOCAL_DIR, { recursive: true });

	// Re-running configure with unchanged cache variables is cheap.
	execFileSync("cmake", ["-S", "runtime", "-B", BUILD_DIR, `-DCMAKE_C_FLAGS=${OPT}`], {
		stdio,
	});

	execFileSync("cmake", ["--build", BUILD_DIR, "--target", "LibMaligator"], { stdio });

	// Build the Rust i18n shim (Date tz + Intl) the runtime links against.
	ensureI18nLibrary(verbose);

	return path.join(BUILD_DIR, "libLibMaligator.a");
}

/**
 * Compile and link an emitted definition into a standalone runnable binary at
 * `.cache/local/<name>`, reusing the test262 harness main as the entry point.
 * Returns the path to the binary.
 */
export function buildLocalBinary(options: LocalBuildOptions): string {
	const lib = ensureRuntimeLibrary(options.verbose);

	const cPath = path.join(LOCAL_DIR, `${options.name}.c`);
	const binPath = path.join(LOCAL_DIR, options.name);
	writeFileSync(cPath, options.cSource);

	execFileSync(
		"cc",
		[
			"-std=c2x",
			OPT,
			"-I",
			"runtime/src",
			"-I",
			I18N_INCLUDE_DIR,
			cPath,
			"runtime/test262_main.c",
			lib,
			...i18nLinkArgs(),
			"-o",
			binPath,
		],
		{ stdio: options.verbose ? "inherit" : "ignore" },
	);

	return binPath;
}
