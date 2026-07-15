import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { requireToolchain } from "./toolchain.ts";
import type { Toolchain } from "./toolchain.ts";

export { resolvePathExecutable } from "./toolchain.ts";

/**
 * Build + link integration for `mal_rust`, the runtime's single Rust FFI shim
 * (ICU4X for Intl, regress for RegExp, later temporal_rs for Temporal).
 *
 * It is one `staticlib` because two Rust staticlibs cannot link into one binary
 * (duplicate std panic-runtime symbols). The C runtime links it for Date tz
 * offsets, the whole Intl surface, and RegExp. We drive cargo through rustup so
 * the pinned toolchain (runtime/rust/rust-toolchain.toml) is honoured, and we
 * keep every cargo artifact under the gitignored `.cache`, so a clean checkout
 * never carries build output.
 *
 * Centralising the lib path + link args here means that when a dependency pulls
 * in std features needing extra macOS frameworks, only `rustLinkArgs` changes —
 * not the cc link sites that consume it.
 */

const RUST_DIR = "runtime/rust";

/** Passed to cc as `-I` so runtime/src/*.c can `#include "mal_i18n.h"` / "mal_regexp.h". */
export const RUST_INCLUDE_DIR = path.join(RUST_DIR, "include");

/** Project-local cargo home + target dir, both under the gitignored `.cache`. */
const CARGO_HOME = path.resolve(".cache/cargo");
const CARGO_TARGET_DIR = path.resolve(".cache/cargo-target");

/**
 * The Intl build axis for the Rust crate. `intlEnabled: false` builds
 * `--no-default-features` (no ICU crates → ~13 MB smaller archive); a non-empty
 * `locales` selects a curated CLDR subset via icu4x-datagen. `cacheSuffix` is the
 * build-config `rustConfigCacheSuffix` (keyed on the Intl axis only, so toggling
 * eval never rebuilds ICU); "" is the canonical Intl-on/all-locales archive.
 */
export interface RustBuildConfig {
	intlEnabled?: boolean;
	/**
	 * Per-service Cargo features (`intl-collator`, …) for a subset Intl build. Empty
	 * = all services (the default `intl-full`). Ignored when `intlEnabled` is false.
	 */
	features?: Array<string>;
	/**
	 * Whether to compile the WHATWG URL (ada) parser — the `web-platform` Cargo
	 * feature (engine surface.webPlatform). Default true. Off drops the C++ ada
	 * library from the archive and the `-lc++` link ({@link rustLinkArgs}).
	 */
	webPlatform?: boolean;
	/**
	 * Whether to compile the RegExp engine (regress) — the `regexp` Cargo feature
	 * (engine.regexp). Default true. Off drops the regex engine + its Unicode tables.
	 */
	regexp?: boolean;
	locales?: Array<string>;
	cacheSuffix?: string;
}

/** Per-config cargo target dir; the canonical ("") config keeps the base dir. */
function rustTargetDir(cacheSuffix: string): string {
	return cacheSuffix ? `${CARGO_TARGET_DIR}-${cacheSuffix}` : CARGO_TARGET_DIR;
}

/** Where cargo drops the staticlib for the given Intl-config suffix. */
export function rustLibPath(cacheSuffix = ""): string {
	return path.join(rustTargetDir(cacheSuffix), "release", "libmal_rust.a");
}

/**
 * Final-link arguments for a binary that uses the runtime: the Rust staticlib
 * (which must follow libLibMaligator.a, since the archive references its
 * symbols) plus any platform libraries Rust std / the vendored crates require.
 * `cacheSuffix` selects the archive matching the binary's Intl config.
 *
 * The shim links clean on macOS with no frameworks so far. Extend here if a
 * future dependency introduces an undefined-symbol link error.
 *
 * ada-url wraps a C++ library whose objects are bundled into libmal_rust.a. The
 * toolchain probe supplies the working C++ runtime link argument (`-lc++` or
 * `-lstdc++`) only when the web-platform feature requires it.
 */
export function rustLinkArgs(
	cacheSuffix = "",
	webPlatform = true,
	cxxLinkArgs: Array<string> = webPlatform
		? requireToolchain({ needsCxx: true }).probes.cxxLinkArgs
		: [],
): Array<string> {
	return webPlatform
		? [rustLibPath(cacheSuffix), ...cxxLinkArgs]
		: [rustLibPath(cacheSuffix)];
}

const builtConfigs = new Set<string>();

/**
 * Build `libmal_rust.a` (release) for the given Intl config if not already built
 * this process. Resolves cargo via the rustup-pinned toolchain and routes all
 * caches into `.cache` (a per-config target dir, so Intl-on/off/subset archives
 * coexist). Returns the path to the static archive. Cheap to call repeatedly:
 * cargo no-ops when nothing changed, and this memoizes per config.
 */
export function ensureRustLibrary(
	verbose = false,
	config: RustBuildConfig = {},
	selectedToolchain?: Toolchain,
): string {
	const intlEnabled = config.intlEnabled ?? true;
	const cacheSuffix = config.cacheSuffix ?? "";
	if (builtConfigs.has(cacheSuffix)) {
		return rustLibPath(cacheSuffix);
	}

	const toolchain =
		selectedToolchain ?? requireToolchain({ needsCxx: config.webPlatform ?? true });
	const currentPath = process.env.PATH ?? "";
	const cargoPath = toolchain.tools.cargo.path;
	const rustcPath = toolchain.tools.rustc.path;
	const toolchainBin = path.dirname(cargoPath);

	// Build an explicit feature set from the resolved config, always with
	// --no-default-features so the archive carries exactly what we ask for:
	//   - Intl on: the per-service subset, or `intl-full` when no subset is given.
	//   - web-platform: the URL (ada) parser, when surface.webPlatform is on.
	//   - regexp: the RegExp engine (regress), when engine.regexp is on.
	// jiff (tz) is non-optional and always compiles.
	const features = config.features ?? [];
	const webPlatform = config.webPlatform ?? true;
	const regexp = config.regexp ?? true;
	const wantFeatures: Array<string> = [];
	if (intlEnabled) {
		wantFeatures.push(...(features.length > 0 ? features : ["intl-full"]));
	}
	if (webPlatform) {
		wantFeatures.push("web-platform");
	}
	if (regexp) {
		wantFeatures.push("regexp");
	}
	const args = ["build", "--release", "--no-default-features"];
	if (wantFeatures.length > 0) {
		args.push("--features", wantFeatures.join(","));
	}

	execFileSync(cargoPath, args, {
		cwd: RUST_DIR,
		env: {
			...process.env,
			PATH: `${toolchainBin}${path.delimiter}${currentPath}`,
			CC: toolchain.tools.cc.path,
			...(toolchain.tools.cxx === undefined ? {} : { CXX: toolchain.tools.cxx.path }),
			CARGO_HOME,
			CARGO_TARGET_DIR: rustTargetDir(cacheSuffix),
			RUSTC: rustcPath,
		},
		stdio: verbose ? "inherit" : "ignore",
	});

	builtConfigs.add(cacheSuffix);
	return rustLibPath(cacheSuffix);
}
