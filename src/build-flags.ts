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

export type SanitizerMode = "none" | "asan" | "ubsan" | "tsan";

export interface NativeBuildPlan {
	mode: "development" | "production";
	lto: boolean;
	ltoFlags: ReadonlyArray<string>;
	thinLtoCache: "darwin" | "lld" | "plugin" | null;
	strip: boolean;
	warnings: Array<string>;
}

/** Each selectable Intl service's Cargo feature, which Wasm builds compile alone. */
export const INTL_SERVICE_FEATURES: Record<string, { cargo: string }> = {
	collator: { cargo: "intl-collator" },
	"number-format": { cargo: "intl-number-format" },
	"date-time-format": { cargo: "intl-date-time-format" },
	"plural-rules": { cargo: "intl-plural-rules" },
	"list-format": { cargo: "intl-list-format" },
	segmenter: { cargo: "intl-segmenter" },
	"display-names": { cargo: "intl-display-names" },
	"relative-time-format": { cargo: "intl-relative-time-format" },
	"duration-format": { cargo: "intl-duration-format" },
};

export interface NativeFeatureInput {
	/** `-DMAL_PRIMORDIALS_LOCKED=0` for compatibility/conformance builds. */
	primordialsLocked?: boolean;
	evalEnabled?: boolean;
	realmsEnabled?: boolean;
	intlEnabled?: boolean;
	/** Selects the native components shared by host installers. */
	usesHost?: boolean;
	/** Selects Ada for images that reach the URL parser. */
	usesUrlParser?: boolean;
	/** Selects the shared native assembly provider for TLS and Node crypto. */
	usesTlsOrCrypto?: boolean;
	/** An image can reach a native provider that needs Rust's standard library. */
	usesRustStd?: boolean;
	/** An image installs an ICU provider. */
	usesRustIntl?: boolean;
	regexpEnabled?: boolean;
	/** Selects the Temporal Cargo feature for Wasm and permits its native installer. */
	temporalEnabled?: boolean;
	/** `-DMAL_PROFILE=1` for the production-faithful profiling runtime. */
	profileEnabled?: boolean;
	/** Compile the private self-hosted CLI development and test API. */
	developmentApiEnabled?: boolean;
	/** Selected per-service Intl Cargo features; empty means the full Intl surface. */
	intlFeatures?: Array<string>;
}

export type NativeHostFeatures = Pick<
	NativeFeatureInput,
	"usesHost" | "usesUrlParser" | "usesTlsOrCrypto" | "usesRustStd" | "usesRustIntl"
>;

/**
 * Normalized feature identity shared by C compilation and the Rust link.
 * `cDefines` are the exact, sorted C arguments. `cargoFeatures` name the Rust
 * components the build selects. Wasm compiles the selected Cargo features.
 * Native links use the installer requirements to choose an archive and
 * the selected components' native libraries.
 */
export interface NativeFeatureSpec {
	primordialsLocked: boolean;
	evalEnabled: boolean;
	realmsEnabled: boolean;
	intlEnabled: boolean;
	usesHost: boolean;
	usesUrlParser: boolean;
	usesTlsOrCrypto: boolean;
	usesRustStd: boolean;
	usesRustIntl: boolean;
	regexpEnabled: boolean;
	temporalEnabled: boolean;
	profileEnabled: boolean;
	developmentApiEnabled: boolean;
	intlFeatures: Array<string>;
	cDefines: Array<string>;
	cargoFeatures: Array<string>;
}

function sortedUnique(values: Array<string>): Array<string> {
	return [...new Set(values)].sort();
}

/** Derive C defines and Cargo features from the native feature inputs. */
export function normalizeNativeFeatures(
	input: NativeFeatureInput = {},
): NativeFeatureSpec {
	const primordialsLocked = input.primordialsLocked ?? true;
	const evalEnabled = input.evalEnabled ?? true;
	const realmsEnabled = input.realmsEnabled ?? true;
	const intlEnabled = input.intlEnabled ?? true;
	const usesHost = input.usesHost ?? true;
	const usesUrlParser = input.usesUrlParser ?? usesHost;
	const usesTlsOrCrypto = input.usesTlsOrCrypto ?? usesHost;
	const usesRustStd = input.usesRustStd ?? true;
	const usesRustIntl = input.usesRustIntl ?? true;
	const regexpEnabled = input.regexpEnabled ?? true;
	const temporalEnabled = input.temporalEnabled ?? true;
	const profileEnabled = input.profileEnabled ?? false;
	const developmentApiEnabled = input.developmentApiEnabled ?? false;
	const services = Object.values(INTL_SERVICE_FEATURES);
	const knownCargoFeatures = new Set(services.map(({ cargo }) => cargo));
	const intlFeatures = sortedUnique(input.intlFeatures ?? []);

	if (intlEnabled) {
		for (const feature of intlFeatures) {
			if (!knownCargoFeatures.has(feature)) {
				throw new Error(`unknown Intl Cargo feature: ${feature}`);
			}
		}
	}

	const cDefines = [
		...(primordialsLocked ? [] : ["-DMAL_PRIMORDIALS_LOCKED=0"]),
		...(realmsEnabled ? [] : ["-DMAL_REALMS=0"]),
		...(profileEnabled ? ["-DMAL_PROFILE=1"] : []),
		...(developmentApiEnabled ? ["-DMAL_DEVELOPMENT_API=1"] : []),
	];
	const cargoFeatures = sortedUnique([
		...(intlEnabled ? (intlFeatures.length > 0 ? intlFeatures : ["intl-full"]) : []),
		...(usesHost ? ["zlib", "node-argon2"] : []),
		...(usesTlsOrCrypto ? ["tls", "node-crypto"] : []),
		...(usesUrlParser ? ["url"] : []),
		...(regexpEnabled ? ["regexp"] : []),
		...(temporalEnabled ? ["temporal"] : []),
	]);
	return {
		primordialsLocked,
		evalEnabled,
		realmsEnabled,
		intlEnabled,
		usesHost,
		usesUrlParser,
		usesTlsOrCrypto,
		usesRustStd,
		usesRustIntl,
		regexpEnabled,
		temporalEnabled,
		profileEnabled,
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
	if (envOn("MAL_TSAN", env)) {
		if (envOn("MAL_ASAN", env) || envOn("MAL_UBSAN", env)) {
			throw new Error("ThreadSanitizer cannot be combined with ASan or UBSan");
		}
		return "tsan";
	}
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
		// Fake stack frames would hide locals from conservative roots and frame records.
		"-fsanitize-address-use-after-return=never",
	],
	ubsan: ["-fsanitize=undefined", "-fno-sanitize-recover=all", "-fno-omit-frame-pointer"],
	tsan: ["-fsanitize=thread", "-fno-sanitize-recover=all", "-fno-omit-frame-pointer"],
};

export function rejectObsoleteGcModes(env: NodeJS.ProcessEnv = process.env): void {
	for (const name of [
		"MAL_GC_GENERATIONAL",
		"MAL_GC_CONCURRENT",
		"MAL_GC_MODE",
		"MAL_GC_OFF",
	]) {
		if (env[name] !== undefined) {
			throw new Error(`${name} was removed; Maligator builds one generational collector`);
		}
	}
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
	rejectObsoleteGcModes(env);
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
 * strip discards. Under a sanitizer: -O1 -gline-tables-only (the sanitizer is
 * slow; a non-zero -O with line tables keeps frames and file:line symbolization,
 * while full DWARF would only slow every instrumented compile).
 */
export function optFlags(
	plan?: NativeBuildPlan,
	env: NodeJS.ProcessEnv = process.env,
): Array<string> {
	if (sanitizerMode(env) !== "none") {
		return ["-O1", "-gline-tables-only"];
	}
	return plan?.lto === true ? ["-O2", "-g0", ...plan.ltoFlags] : ["-O2", "-g0"];
}

/**
 * Handwritten runtime objects compile once per toolchain and flag set and are reused
 * by every program, so they take -O3 where generated units keep -O2 for build time.
 */
export function runtimeOptimizationFlags(
	env: NodeJS.ProcessEnv = process.env,
): Array<string> {
	return sanitizerMode(env) === "none" ? ["-O3"] : [];
}

/**
 * Every program links the same runtime archives and keeps what it reaches, so runtime
 * objects give each function and datum its own section wherever the final link
 * removes unused sections. Without them an ELF link keeps a whole object, such as
 * every Intl service, for one reachable function. Mach-O links already divide
 * sections at each symbol.
 */
export function runtimeSectionFlags(
	platform: NodeJS.Platform,
	sectionGcLinkArgs: ReadonlyArray<string>,
): Array<string> {
	return platform !== "darwin" && sectionGcLinkArgs.length > 0
		? ["-ffunction-sections", "-fdata-sections"]
		: [];
}

export function unwindTableCcFlags(
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
): Array<string> {
	return platform === "linux" && sanitizerMode(env) === "none"
		? ["-fno-asynchronous-unwind-tables", "-fno-unwind-tables"]
		: [];
}

/** Shared compiler flags; callers append the normalized feature defines. */
export function ccExtraFlags(
	plan?: NativeBuildPlan,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): Array<string> {
	rejectObsoleteGcModes(env);
	return [
		...platformCcFlags(platform),
		...optFlags(plan, env),
		// Stack-trace capture walks frame-pointer chains through runtime and generated frames.
		"-fno-omit-frame-pointer",
		...unwindTableCcFlags(platform, env),
		...SANITIZER_FLAGS[sanitizerMode(env)],
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

/** Select the native test instruments without inheriting another malloc instrument. */
export function sanitizerTestEnvironment(
	platform: NodeJS.Platform,
	base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const inserted = base.DYLD_INSERT_LIBRARIES?.split(":")
		.filter((file) => file !== GMALLOC_PATH)
		.join(":");
	return {
		...base,
		MAL_ASAN: platform === "darwin" ? "0" : "1",
		MAL_UBSAN: platform === "darwin" ? "1" : "0",
		MAL_TSAN: "0",
		MAL_GMALLOC: "0",
		MAL_GC_AT_EXIT: "1",
		DYLD_INSERT_LIBRARIES: inserted || undefined,
		ASAN_OPTIONS: "abort_on_error=1:detect_leaks=1:halt_on_error=1",
		UBSAN_OPTIONS: "halt_on_error=1:print_stacktrace=1",
	};
}

/** True when the binary should be run under Guard Malloc (`MAL_GMALLOC=1`). */
export function gmallocEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return envOn("MAL_GMALLOC", env);
}

/**
 * Environment for running a built binary. Under `MAL_GMALLOC=1` this injects
 * Guard Malloc (the working macOS UAF instrument) plus scribble/guard-edge knobs
 * so freed and just-allocated memory is poisoned and small overruns are caught.
 * Otherwise returns `base` unchanged.
 */
export function runEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	if (!gmallocEnabled(base)) {
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
