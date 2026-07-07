/**
 * Shared C build-flag + run-env selection for the native backends. Centralises
 * the GC validation instruments so the local build (`local-build.ts`) and the
 * test262 runner agree on flags and on the build directory they use.
 *
 * ## The instruments (and why ASAN is not the default here)
 *
 * AddressSanitizer DOES NOT WORK on this machine: on macOS 26.x both Apple
 * clang-17 and Homebrew clang-21 deadlock during `__asan::AsanInitInternal`
 * (shadow-memory init re-enters the ASAN malloc wrapper while iterating the dyld
 * shared cache and spins on the init spinlock forever — a sanitizer-runtime bug,
 * not ours). The build wiring is kept (`MAL_ASAN=1`) so it works on Linux/CI and
 * whenever Apple fixes the runtime, but on macOS the usable instruments are:
 *
 *  - **Guard Malloc** (`MAL_GMALLOC=1`): the primary use-after-free / double-free
 *    / heap-overflow detector. Injected at run time via `DYLD_INSERT_LIBRARIES`,
 *    so it needs NO special build — it instruments the per-cell owned libc memory
 *    (overflow tables, `slots` buffers, Map entries, ArrayBuffer data, Rust
 *    handles). The GC's own cells live in mmap'd chunks it cannot see — pair it
 *    with `MAL_GC_VERIFY` (poison-on-free) for cells and `MAL_GC_STRESS` to force
 *    collection.
 *  - **UBSan** (`MAL_UBSAN=1`): compile-time `-fsanitize=undefined`. Works on
 *    macOS (no shadow memory), catches runtime UB in the C runtime.
 *  - **`leaks`** (the macOS tool): shutdown leak detection, run separately.
 */

export type SanitizerMode = "none" | "asan" | "ubsan";

/** True when `name` is set to a non-empty, non-"0" value. */
function envOn(name: string): boolean {
	const value = process.env[name];
	return value !== undefined && value !== "" && value !== "0";
}

/**
 * The compile-time sanitizer mode. `MAL_ASAN` takes precedence over `MAL_UBSAN`
 * (ASAN already implies UBSan in our flag set). Off by default so normal builds
 * stay at -O2 with no overhead or extra build directory.
 */
export function sanitizerMode(): SanitizerMode {
	if (envOn("MAL_ASAN")) {
		return "asan";
	}
	if (envOn("MAL_UBSAN")) {
		return "ubsan";
	}
	return "none";
}

/**
 * Sanitizer flags per mode; appear on BOTH compile and link (the link pulls in
 * the sanitizer runtimes). UBSan defaults to print-and-continue (no
 * `-fno-sanitize-recover`), so a benign report does not abort a passing run;
 * ASAN still halts on a real memory error. `-fno-omit-frame-pointer` keeps
 * reports readable.
 */
const SANITIZER_FLAGS: Record<SanitizerMode, Array<string>> = {
	none: [],
	asan: ["-fsanitize=address,undefined", "-fno-omit-frame-pointer"],
	ubsan: ["-fsanitize=undefined", "-fno-omit-frame-pointer"],
};

/**
 * Whether to build the generational collector (`MAL_GC_GENERATIONAL=1`): a
 * non-moving sticky-mark-bit minor collector layered on the STW mark-sweep. Off by
 * default — the inliner already removes most young garbage, so it stays an opt-in
 * build dimension (the day-one barrier sites compile to nothing when off, §5.4a).
 */
export function gcGenerational(): boolean {
	return envOn("MAL_GC_GENERATIONAL");
}

/** Preprocessor defines selecting GC build dimensions. */
export function gcDefines(): Array<string> {
	return gcGenerational() ? ["-DMAL_GC_GENERATIONAL=1"] : [];
}

/**
 * Build-directory / binary suffix for the current mode, so toggling a sanitizer or
 * the generational collector does not thrash the normal -O2 archive (CMAKE_C_FLAGS
 * is cached per build dir, and the header layout / barrier code differs). Empty for
 * the normal build.
 *
 * `cacheSuffix` folds in a hash of the build-affecting build config
 * (build-config.ts `buildConfigCacheSuffix`), so an eval-disabled binary (which
 * embeds no compiler and defines `-DMAL_EVAL=0`) gets its own archive rather than
 * clobbering the default eval-on one. Empty (the default) keeps the unsuffixed dir.
 */
export function buildSuffix(cacheSuffix = ""): string {
	const mode = sanitizerMode();
	let suffix = mode === "none" ? "" : `-${mode}`;
	if (gcGenerational()) {
		suffix += "-gen";
	}
	if (cacheSuffix) {
		suffix += `-${cacheSuffix}`;
	}
	return suffix;
}

/**
 * Optimisation/debug flags for the current mode. Normal: -O2. Under a sanitizer:
 * -O1 -g (the sanitizer is slow, and -g + a non-zero -O keeps frames + symbols).
 */
export function optFlags(): Array<string> {
	return sanitizerMode() === "none" ? ["-O2"] : ["-O1", "-g"];
}

/**
 * The single `-DCMAKE_C_FLAGS=...` value for configuring LibMaligator. Passing
 * `evalEnabled: false` adds `-DMAL_EVAL=0`, which drops the `#embed` of the 1.6 MB
 * baked compiler and turns the eval/Function runtime path into an EvalError throw.
 * `intlEnabled: false` adds `-DMAL_INTL=0`, which drops the Intl global + the ICU
 * call sites (kept in lockstep with the Rust `intl` Cargo feature).
 */
export function cmakeCFlags(
	opts: {
		evalEnabled?: boolean;
		intlEnabled?: boolean;
		/** `-DMAL_INTL_HAS_<SERVICE>=0` for each dropped service (subset Intl build). */
		intlServiceDefines?: Array<string>;
	} = {},
): string {
	const evalFlag = opts.evalEnabled === false ? ["-DMAL_EVAL=0"] : [];
	// Intl off → -DMAL_INTL=0 (per-service gates default to MAL_INTL, so all off).
	// Intl on → per-service disable defines (empty for the full build).
	const intlFlags =
		opts.intlEnabled === false ? ["-DMAL_INTL=0"] : (opts.intlServiceDefines ?? []);
	return [
		...optFlags(),
		...SANITIZER_FLAGS[sanitizerMode()],
		...gcDefines(),
		...evalFlag,
		...intlFlags,
	].join(" ");
}

/** Extra cc flags (compile + link) for an emitted translation unit. */
export function ccExtraFlags(): Array<string> {
	return [...optFlags(), ...SANITIZER_FLAGS[sanitizerMode()], ...gcDefines()];
}

const GMALLOC_PATH = "/usr/lib/libgmalloc.dylib";

/** True when the binary should be run under Guard Malloc (`MAL_GMALLOC=1`). */
export function gmallocEnabled(): boolean {
	return envOn("MAL_GMALLOC");
}

/**
 * Environment for running a built binary. Under `MAL_GMALLOC=1` this injects
 * Guard Malloc (the working macOS UAF instrument) plus scribble/guard-edge knobs
 * so freed and just-allocated memory is poisoned and small overruns are caught.
 * Otherwise returns `base` unchanged.
 */
export function runEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	if (!gmallocEnabled()) {
		return base;
	}
	const existing = base.DYLD_INSERT_LIBRARIES;
	return {
		...base,
		DYLD_INSERT_LIBRARIES: existing ? `${GMALLOC_PATH}:${existing}` : GMALLOC_PATH,
		MallocScribble: "1",
		MallocPreScribble: "1",
		MallocGuardEdges: "1",
	};
}
