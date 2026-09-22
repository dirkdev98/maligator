/**
 * Shared C build-flag + run-env selection for the native backends. Centralises
 * the GC validation instruments so local builds and the test262 runner agree on
 * build-affecting flags without sharing output directories.
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
 *   MAL_ASAN=1 MAL_GC_STRESS=2 node scripts/test262.ts \
 *     --manifest tests/test-suite-test262-smoke.txt \
 *     --manifest tests/test-suite-test262-check.txt --check --policy complete
 *
 *   # macOS (ASan deadlocks in AsanInitInternal — use the working stack instead):
 *   MAL_GC_STRESS=2 MAL_GC_VERIFY=1 npm run test:native          # cell poison-on-free
 *   MAL_GMALLOC=1 MAL_GC_STRESS=2 node scripts/test262.ts \
 *     --manifest tests/test-suite-test262-smoke.txt \
 *     --manifest tests/test-suite-test262-check.txt --check --policy complete # libc-buffer UAF
 */

import type { Toolchain } from "./toolchain.ts";

export type SanitizerMode = "none" | "asan" | "ubsan";

export interface NativeBuildPlan {
	mode: "development" | "production";
	lto: boolean;
	ltoFlags: ReadonlyArray<string>;
	thinLtoCache: "darwin" | "lld" | null;
	strip: boolean;
	warnings: Array<string>;
}

/** One source of truth for each selectable Intl service's C and Cargo gates. */
export const INTL_SERVICE_FEATURES: Record<string, { cargo: string; define: string }> = {
	collator: { cargo: "intl-collator", define: "MAL_INTL_HAS_COLLATOR" },
	"number-format": { cargo: "intl-number-format", define: "MAL_INTL_HAS_NUMBER_FORMAT" },
	"date-time-format": {
		cargo: "intl-date-time-format",
		define: "MAL_INTL_HAS_DATE_TIME_FORMAT",
	},
	"plural-rules": { cargo: "intl-plural-rules", define: "MAL_INTL_HAS_PLURAL_RULES" },
	"list-format": { cargo: "intl-list-format", define: "MAL_INTL_HAS_LIST_FORMAT" },
	segmenter: { cargo: "intl-segmenter", define: "MAL_INTL_HAS_SEGMENTER" },
	"display-names": { cargo: "intl-display-names", define: "MAL_INTL_HAS_DISPLAY_NAMES" },
	"relative-time-format": {
		cargo: "intl-relative-time-format",
		define: "MAL_INTL_HAS_RELATIVE_TIME_FORMAT",
	},
	"duration-format": {
		cargo: "intl-duration-format",
		define: "MAL_INTL_HAS_DURATION_FORMAT",
	},
};

export interface NativeFeatureInput {
	/** `-DMAL_PRIMORDIALS_LOCKED=0` for compatibility/conformance builds. */
	primordialsLocked?: boolean;
	evalEnabled?: boolean;
	realmsEnabled?: boolean;
	intlEnabled?: boolean;
	/** `-DMAL_INTL_HAS_<SERVICE>=0` for each dropped service (subset Intl build). */
	intlServiceDefines?: Array<string>;
	webPlatformEnabled?: boolean;
	regexpEnabled?: boolean;
	/** `-DMAL_TEMPORAL=0` when the Temporal surface is excluded (default on internally). */
	temporalEnabled?: boolean;
	/** `-DMAL_NODE=1` when the node host built-in surface is enabled (default off). */
	nodeEnabled?: boolean;
	/** `-DMAL_PROFILE=1` for the production-faithful profiling runtime. */
	profileEnabled?: boolean;
	pgoEnabled?: boolean;
	/** Compile the private self-hosted CLI development and test API. */
	developmentApiEnabled?: boolean;
	/** Selected per-service Intl Cargo features; empty means the full Intl surface. */
	intlFeatures?: Array<string>;
}

/**
 * Normalized feature identity shared by C compilation and the Rust Cargo build.
 * `cDefines` and `cargoFeatures` are the exact, sorted arguments used by each
 * backend and are always derived together.
 */
export interface NativeFeatureSpec {
	primordialsLocked: boolean;
	evalEnabled: boolean;
	realmsEnabled: boolean;
	intlEnabled: boolean;
	webPlatformEnabled: boolean;
	regexpEnabled: boolean;
	temporalEnabled: boolean;
	nodeEnabled: boolean;
	profileEnabled: boolean;
	pgoEnabled: boolean;
	developmentApiEnabled: boolean;
	intlFeatures: Array<string>;
	cDefines: Array<string>;
	cargoFeatures: Array<string>;
}

function sortedUnique(values: Array<string>): Array<string> {
	return [...new Set(values)].sort();
}

/** Normalize legacy feature fields into the single native backend specification. */
export function normalizeNativeFeatures(
	input: NativeFeatureInput = {},
): NativeFeatureSpec {
	const primordialsLocked = input.primordialsLocked ?? true;
	const evalEnabled = input.evalEnabled ?? true;
	const realmsEnabled = input.realmsEnabled ?? true;
	const intlEnabled = input.intlEnabled ?? true;
	const webPlatformEnabled = input.webPlatformEnabled ?? true;
	const regexpEnabled = input.regexpEnabled ?? true;
	const temporalEnabled = input.temporalEnabled ?? true;
	const nodeEnabled = input.nodeEnabled ?? false;
	const profileEnabled = input.profileEnabled ?? false;
	const pgoEnabled = input.pgoEnabled ?? false;
	const developmentApiEnabled = input.developmentApiEnabled ?? false;
	const services = Object.values(INTL_SERVICE_FEATURES);
	const knownCargoFeatures = new Set(services.map(({ cargo }) => cargo));
	const knownDisableDefines = new Set(services.map(({ define }) => `-D${define}=0`));
	let intlFeatures = sortedUnique(input.intlFeatures ?? []);
	const suppliedDefines = sortedUnique(input.intlServiceDefines ?? []);

	if (intlEnabled) {
		for (const feature of intlFeatures) {
			if (!knownCargoFeatures.has(feature)) {
				throw new Error(`unknown Intl Cargo feature: ${feature}`);
			}
		}
		for (const define of suppliedDefines) {
			if (!knownDisableDefines.has(define)) {
				throw new Error(`unknown Intl service define: ${define}`);
			}
		}
		if (intlFeatures.length === 0 && suppliedDefines.length > 0) {
			const disabled = new Set(suppliedDefines);
			intlFeatures = sortedUnique(
				services
					.filter(({ define }) => !disabled.has(`-D${define}=0`))
					.map(({ cargo }) => cargo),
			);
		}
	}

	const intlDefines =
		!intlEnabled || intlFeatures.length === 0
			? []
			: sortedUnique(
					services
						.filter(({ cargo }) => !intlFeatures.includes(cargo))
						.map(({ define }) => `-D${define}=0`),
				);
	if (intlEnabled && suppliedDefines.length > 0) {
		if (JSON.stringify(suppliedDefines) !== JSON.stringify(intlDefines)) {
			throw new Error("Intl C defines and Cargo features select different services");
		}
	}

	const cDefines = [
		...(primordialsLocked ? [] : ["-DMAL_PRIMORDIALS_LOCKED=0"]),
		...(evalEnabled ? [] : ["-DMAL_EVAL=0"]),
		...(realmsEnabled ? [] : ["-DMAL_REALMS=0"]),
		...(intlEnabled ? intlDefines : ["-DMAL_INTL=0"]),
		...(webPlatformEnabled ? [] : ["-DMAL_WEB_PLATFORM=0"]),
		...(regexpEnabled ? [] : ["-DMAL_REGEXP=0"]),
		...(temporalEnabled ? [] : ["-DMAL_TEMPORAL=0"]),
		...(nodeEnabled ? ["-DMAL_NODE=1"] : []),
		...(profileEnabled ? ["-DMAL_PROFILE=1"] : []),
		...(pgoEnabled ? ["-DMAL_PGO=1"] : []),
		...(developmentApiEnabled ? ["-DMAL_DEVELOPMENT_API=1"] : []),
	];
	const cargoFeatures = sortedUnique([
		...(intlEnabled ? (intlFeatures.length > 0 ? intlFeatures : ["intl-full"]) : []),
		...(webPlatformEnabled || nodeEnabled ? ["url"] : []),
		...(regexpEnabled ? ["regexp"] : []),
		...(temporalEnabled ? ["temporal"] : []),
		...(nodeEnabled ? ["node-argon2", "node-tls", "node-zlib"] : []),
	]);
	return {
		primordialsLocked,
		evalEnabled,
		realmsEnabled,
		intlEnabled,
		webPlatformEnabled,
		regexpEnabled,
		temporalEnabled,
		nodeEnabled,
		profileEnabled,
		pgoEnabled,
		developmentApiEnabled,
		intlFeatures,
		cDefines,
		cargoFeatures,
	};
}

/** Select optional production capabilities once, before any native build step. */
export function selectNativeBuildPlan(
	toolchain: Toolchain,
	production: boolean,
): NativeBuildPlan {
	if (!production) {
		return {
			mode: "development",
			lto: false,
			ltoFlags: [],
			thinLtoCache: null,
			strip: false,
			warnings: [],
		};
	}
	const warnings: Array<string> = [];
	if (!toolchain.probes.lto) {
		warnings.push(
			"production LTO is unsupported; continuing at -O2 (run 'maligator doctor --verbose' to inspect the probe)",
		);
	}
	if (!toolchain.probes.strip || toolchain.tools.strip === undefined) {
		warnings.push(
			"production symbol stripping is unsupported; leaving the binary unstripped (run 'maligator doctor --verbose' to inspect the probe)",
		);
	}
	return {
		mode: "production",
		lto: toolchain.probes.lto,
		ltoFlags: toolchain.probes.ltoFlags,
		thinLtoCache: toolchain.probes.thinLtoCache,
		strip: toolchain.probes.strip && toolchain.tools.strip !== undefined,
		warnings,
	};
}

/** True when `name` is set to a non-empty, non-"0" value. */
function envOn(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env[name];
	return value !== undefined && value !== "" && value !== "0";
}

/**
 * The compile-time sanitizer mode. `MAL_ASAN` takes precedence over `MAL_UBSAN`
 * (ASAN already implies UBSan in our flag set). Off by default so normal builds
 * stay at -O2 with no overhead or extra build directory.
 */
export function sanitizerMode(env: NodeJS.ProcessEnv = process.env): SanitizerMode {
	if (envOn("MAL_ASAN", env)) {
		return "asan";
	}
	if (envOn("MAL_UBSAN", env)) {
		return "ubsan";
	}
	return "none";
}

/**
 * Sanitizer flags per mode; appear on BOTH compile and link (the link pulls in
 * the sanitizer runtimes). Reports are fatal so a diagnostic cannot leave the
 * sanitizer gate green. `-fno-omit-frame-pointer` keeps reports readable.
 */
const SANITIZER_FLAGS: Record<SanitizerMode, Array<string>> = {
	none: [],
	asan: [
		"-fsanitize=address,undefined",
		"-fno-sanitize-recover=all",
		"-fno-omit-frame-pointer",
	],
	ubsan: ["-fsanitize=undefined", "-fno-sanitize-recover=all", "-fno-omit-frame-pointer"],
};

/**
 * Whether to build the generational collector (`MAL_GC_GENERATIONAL`): a
 * non-moving sticky-mark-bit minor collector layered on the STW mark-sweep. ON by
 * default (2026-07-10 flip — the measured per-store card tax is ~1.3% median on
 * store-heavy micros). Opt out with an explicit `MAL_GC_GENERATIONAL=0` (the
 * card-barrier sites then compile to nothing, §5.4a) for minimal/bare-metal
 * profiles; any other value (incl. unset) keeps it on.
 */
export function gcGenerational(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.MAL_GC_GENERATIONAL !== "0";
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
export function gcConcurrent(env: NodeJS.ProcessEnv = process.env): boolean {
	return envOn("MAL_GC_CONCURRENT", env);
}

/**
 * Whether to compile the opt-in property/key performance counters. The counter
 * sites are compiled out of normal binaries because even predictable branches
 * materially distort the hot paths they measure. An instrumented binary still
 * checks `MAL_PERF_STATS` at runtime before accumulating or printing counters.
 */
export function perfStatsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return envOn("MAL_PERF_STATS", env);
}

/** Preprocessor gate for the zero-cost-when-unbuilt performance counters. */
export function perfStatsDefines(env: NodeJS.ProcessEnv = process.env): Array<string> {
	return perfStatsEnabled(env) ? ["-DMAL_PERF_STATS=1"] : [];
}

/**
 * Preprocessor defines selecting GC build dimensions. The generational define is
 * emitted EXPLICITLY (=1 or =0) rather than only when opted in: the opt-out
 * (`=0`) must reach the C preprocessor end-to-end, and stamping the value into
 * every cc flag set also changes the test262 artifact-cache fingerprint so the
 * 2026-07-10 default flip cannot silently reuse pre-flip (non-gen) objects.
 */
export function gcDefines(env: NodeJS.ProcessEnv = process.env): Array<string> {
	return [
		`-DMAL_GC_GENERATIONAL=${gcGenerational(env) ? 1 : 0}`,
		...(gcConcurrent(env) ? ["-DMAL_GC_CONCURRENT=1"] : []),
	];
}

/**
 * Binary suffix for the current sanitizer/GC/instrumentation mode. Native
 * archives carry these exact compiler flags in their content-addressed identity.
 * Empty for the normal build.
 *
 * `cacheSuffix` is a human-facing build-config decoration only. It does not select
 * or identify C/Rust archives. Empty (the default) keeps the unsuffixed binary name.
 */
export function buildSuffix(
	cacheSuffix = "",
	env: NodeJS.ProcessEnv = process.env,
): string {
	const mode = sanitizerMode(env);
	let suffix = mode === "none" ? "" : `-${mode}`;
	// Generational is the default (2026-07-10 flip), so it is UNSUFFIXED; the
	// opt-out (`MAL_GC_GENERATIONAL=0`) gets its own `-nongen` dir so the two
	// dimensions never share an archive/cache (header layout + barrier code differ).
	if (!gcGenerational(env)) {
		suffix += "-nongen";
	}
	if (gcConcurrent(env)) {
		suffix += "-conc";
	}
	if (perfStatsEnabled(env)) {
		suffix += "-perf";
	}
	if (cacheSuffix) {
		suffix += `-${cacheSuffix}`;
	}
	return suffix;
}

/**
 * Optimisation/debug flags for the current mode. Normal: -O2 -g0. The explicit
 * debug disable keeps cross builds from inheriting Zig's DWARF default; generated
 * production units can otherwise spend minutes building metadata that the final
 * strip discards. Under a sanitizer: -O1 -g (the sanitizer is slow, and -g + a
 * non-zero -O keeps frames + symbols).
 */
export function optFlags(
	plan?: NativeBuildPlan,
	env: NodeJS.ProcessEnv = process.env,
): Array<string> {
	if (sanitizerMode(env) !== "none") {
		return ["-O1", "-g"];
	}
	return plan?.lto === true ? ["-O2", "-g0", ...plan.ltoFlags] : ["-O2", "-g0"];
}

/** Shared compiler flags; callers append the normalized feature defines. */
export function ccExtraFlags(
	plan?: NativeBuildPlan,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): Array<string> {
	return [
		...platformCcFlags(platform),
		...optFlags(plan, env),
		...SANITIZER_FLAGS[sanitizerMode(env)],
		...gcDefines(env),
		...perfStatsDefines(env),
	];
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

/**
 * Platform feature-test macros and threading flags that must reach EVERY C
 * translation unit linked into a runtime binary. glibc gates POSIX/GNU
 * declarations (clock_gettime, kill, usleep, pthread_getattr_np, …) behind
 * `_GNU_SOURCE` and needs `-pthread` for its threading; macOS exposes them with no
 * feature macro. Applied uniformly across the runtime archives, the harness mains,
 * and the emitted translation unit so all objects agree on the same glibc surface.
 */
export function platformCcFlags(
	platform: NodeJS.Platform = process.platform,
): Array<string> {
	return platform === "linux" ? ["-D_GNU_SOURCE", "-pthread"] : [];
}

/**
 * System libraries appended at the very end of every final link. macOS folds libm
 * (and pthread/dl) into libSystem, so nothing is needed there; glibc keeps libm
 * separate, so the runtime's <math.h> users (builtin_math.c et al.) need an
 * explicit `-lm`. A Zig-linked Linux Rust staticlib also needs Zig's `libunwind`
 * made explicit; native cc drivers normally add their platform unwind runtime
 * themselves. These must trail the runtime archives so the linker resolves the
 * archives' references left-to-right.
 */
export function platformLinkArgs(
	platform: NodeJS.Platform = process.platform,
	zigCross = false,
): Array<string> {
	return platform === "linux" ? ["-lm", ...(zigCross ? ["-lunwind"] : [])] : [];
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
