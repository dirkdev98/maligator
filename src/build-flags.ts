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
 *
 * ## Running the GC instrument (the primary UAF / double-free lane)
 *
 * The GC fixtures already run under MAL_GC_STRESS+MAL_GC_VERIFY inside the native
 * lane (`npm run test:native`), so routine coverage needs no extra entry point.
 * To drive the whole GC lane + the regression manifest under the strongest
 * available memory-error instrument (as a one-off, not part of `npm test`):
 *
 *   # Linux / CI (ASan is the intended primary instrument; see the note above):
 *   MAL_ASAN=1 MAL_GC_STRESS=2 npm run test:native
 *   MAL_ASAN=1 MAL_GC_STRESS=2 npm run test262:regressions
 *
 *   # macOS (ASan deadlocks in AsanInitInternal — use the working stack instead):
 *   MAL_GC_STRESS=2 MAL_GC_VERIFY=1 npm run test:native          # cell poison-on-free
 *   MAL_GMALLOC=1 MAL_GC_STRESS=2 npm run test262:regressions     # libc-buffer UAF
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
 * Whether to build the generational collector (`MAL_GC_GENERATIONAL`): a
 * non-moving sticky-mark-bit minor collector layered on the STW mark-sweep. ON by
 * default (2026-07-10 flip — the measured per-store card tax is ~1.3% median on
 * store-heavy micros). Opt out with an explicit `MAL_GC_GENERATIONAL=0` (the
 * card-barrier sites then compile to nothing, §5.4a) for minimal/bare-metal
 * profiles; any other value (incl. unset) keeps it on.
 */
export function gcGenerational(): boolean {
	return process.env.MAL_GC_GENERATIONAL !== "0";
}

/**
 * Whether to build the concurrent collector (`MAL_GC_CONCURRENT=1`): activates the
 * SATB (snapshot-at-the-beginning) deletion write-barrier half. Off by default —
 * the barrier folds out entirely when off (the day-one barrier sites compile to
 * nothing, §2). Under this build the barrier is compiled ACTIVE-but-inert until the
 * concurrent marker exists: `mal_gc_marking_active` is a real global (false at
 * runtime) and `mal_gc_satb_record` is still a no-op, so it is behaviour-identical
 * while proving every barrier site reads a valid `old_value` on live paths.
 */
export function gcConcurrent(): boolean {
	return envOn("MAL_GC_CONCURRENT");
}

/**
 * Preprocessor defines selecting GC build dimensions. The generational define is
 * emitted EXPLICITLY (=1 or =0) rather than only when opted in: the opt-out
 * (`=0`) must reach the C preprocessor end-to-end, and stamping the value into
 * every cc flag set also changes the test262 artifact-cache fingerprint so the
 * 2026-07-10 default flip cannot silently reuse pre-flip (non-gen) objects.
 */
export function gcDefines(): Array<string> {
	return [
		`-DMAL_GC_GENERATIONAL=${gcGenerational() ? 1 : 0}`,
		...(gcConcurrent() ? ["-DMAL_GC_CONCURRENT=1"] : []),
	];
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
	// Generational is the default (2026-07-10 flip), so it is UNSUFFIXED; the
	// opt-out (`MAL_GC_GENERATIONAL=0`) gets its own `-nongen` dir so the two
	// dimensions never share an archive/cache (header layout + barrier code differ).
	if (!gcGenerational()) {
		suffix += "-nongen";
	}
	if (gcConcurrent()) {
		suffix += "-conc";
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
	if (sanitizerMode() !== "none") {
		return ["-O1", "-g"];
	}
	// Opt-in link-time optimization (`MAL_LTO=1`): compiles the runtime archives and
	// the emitted TU with `-flto` so the C compiler inlines across translation units
	// (the emitted native-C backend's calls into the runtime — mal_vm_binary_op, the
	// IC ops, value helpers) and dead-strips unreachable code at link. Off by default
	// (it lengthens the link); the flag must reach both the archive (CMAKE_C_FLAGS)
	// and the final cc, which optFlags feeds via cmakeCFlags/ccExtraFlags.
	return envOn("MAL_LTO") ? ["-O2", "-flto"] : ["-O2"];
}

/**
 * The single `-DCMAKE_C_FLAGS=...` value for configuring LibMaligator. Passing
 * `evalEnabled: false` adds `-DMAL_EVAL=0`, which drops the `#embed` of the 1.6 MB
 * baked compiler and turns the eval/Function runtime path into an EvalError throw.
 * `intlEnabled: false` adds `-DMAL_INTL=0`, which drops the Intl global + the ICU
 * call sites (kept in lockstep with the Rust `intl` Cargo feature).
 * `webPlatformEnabled: false` adds `-DMAL_WEB_PLATFORM=0`, which compiles url.c away
 * so no ada FFI symbols are referenced (in lockstep with the Rust `web-platform`
 * feature, which drops the C++ ada parser + `-lc++`).
 */
export interface FeatureDefineOpts {
	evalEnabled?: boolean;
	intlEnabled?: boolean;
	/** `-DMAL_INTL_HAS_<SERVICE>=0` for each dropped service (subset Intl build). */
	intlServiceDefines?: Array<string>;
	webPlatformEnabled?: boolean;
	regexpEnabled?: boolean;
}

/**
 * The `-D…=0` feature defines a build config projects onto the C preprocessor.
 * These MUST be passed identically to the cmake archive build AND to the final cc
 * that compiles the entry driver (host_main.c / test262_main.c) + the emitted
 * program: the entry driver has `#if MAL_WEB_PLATFORM` gates around the web
 * installs, so if it compiled with the default (all-on) values while the archive
 * compiled them off, it would reference definitions the archive omitted (undefined
 * symbols at link).
 */
export function featureDefines(opts: FeatureDefineOpts = {}): Array<string> {
	const evalFlag = opts.evalEnabled === false ? ["-DMAL_EVAL=0"] : [];
	// Intl off → -DMAL_INTL=0 (per-service gates default to MAL_INTL, so all off).
	// Intl on → per-service disable defines (empty for the full build).
	const intlFlags =
		opts.intlEnabled === false ? ["-DMAL_INTL=0"] : (opts.intlServiceDefines ?? []);
	const webFlag = opts.webPlatformEnabled === false ? ["-DMAL_WEB_PLATFORM=0"] : [];
	const regexpFlag = opts.regexpEnabled === false ? ["-DMAL_REGEXP=0"] : [];
	return [...evalFlag, ...intlFlags, ...webFlag, ...regexpFlag];
}

export function cmakeCFlags(opts: FeatureDefineOpts = {}): string {
	return [
		...optFlags(),
		...SANITIZER_FLAGS[sanitizerMode()],
		...gcDefines(),
		...featureDefines(opts),
	].join(" ");
}

/** Extra cc flags (compile + link) for an emitted translation unit. */
export function ccExtraFlags(): Array<string> {
	return [...optFlags(), ...SANITIZER_FLAGS[sanitizerMode()], ...gcDefines()];
}

/**
 * Just the sanitizer flags (`-fsanitize=…`) for the current mode, without the
 * opt/gc flags. The test262 runner keeps its own `-O0` (fast compile) but must
 * still add these to EVERY cc — the generated-C object, the harness mains, and
 * the final link — or an ASan/UBSan-instrumented archive links with undefined
 * sanitizer-runtime symbols. Empty for a normal build.
 */
export function sanitizerCcFlags(): Array<string> {
	return SANITIZER_FLAGS[sanitizerMode()];
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
