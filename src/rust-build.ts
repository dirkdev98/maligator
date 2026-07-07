import { execFileSync } from "node:child_process";
import * as path from "node:path";

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
 * `-lc++`: ada-url (URL parser) wraps the C++ `ada` library, whose objects are
 * bundled into libmal_rust.a, so the final link needs the C++ stdlib. On this
 * macOS/clang toolchain that is libc++ (`-lc++`); a gcc/Linux port would use
 * `-lstdc++`.
 */
export function rustLinkArgs(cacheSuffix = ""): Array<string> {
	return [rustLibPath(cacheSuffix), "-lc++"];
}

const builtConfigs = new Set<string>();

/**
 * Build `libmal_rust.a` (release) for the given Intl config if not already built
 * this process. Resolves cargo via the rustup-pinned toolchain and routes all
 * caches into `.cache` (a per-config target dir, so Intl-on/off/subset archives
 * coexist). Returns the path to the static archive. Cheap to call repeatedly:
 * cargo no-ops when nothing changed, and this memoizes per config.
 */
export function ensureRustLibrary(verbose = false, config: RustBuildConfig = {}): string {
	const intlEnabled = config.intlEnabled ?? true;
	const cacheSuffix = config.cacheSuffix ?? "";
	if (builtConfigs.has(cacheSuffix)) {
		return rustLibPath(cacheSuffix);
	}

	const pathWithBrew = `/opt/homebrew/bin:${process.env.PATH ?? ""}`;

	// `rustup which cargo`, run inside the crate, honours rust-toolchain.toml and
	// gives us the toolchain bin dir to put on PATH so cargo finds its own rustc
	// (there are no rustup proxies on PATH in this environment).
	const cargoPath = execFileSync("rustup", ["which", "cargo"], {
		cwd: RUST_DIR,
		env: { ...process.env, PATH: pathWithBrew },
		encoding: "utf-8",
	}).trim();
	const toolchainBin = path.dirname(cargoPath);

	// Intl off → drop all default features (no ICU crates compiled). A selected
	// service subset → --no-default-features + just those per-service features (each
	// pulls the `intl` floor). All services (empty list) → the default `intl-full`.
	const features = config.features ?? [];
	const args = ["build", "--release"];
	if (!intlEnabled) {
		args.push("--no-default-features");
	} else if (features.length > 0) {
		args.push("--no-default-features", "--features", features.join(","));
	}

	execFileSync("cargo", args, {
		cwd: RUST_DIR,
		env: {
			...process.env,
			PATH: `${toolchainBin}:${pathWithBrew}`,
			CARGO_HOME,
			CARGO_TARGET_DIR: rustTargetDir(cacheSuffix),
		},
		stdio: verbose ? "inherit" : "ignore",
	});

	builtConfigs.add(cacheSuffix);
	return rustLibPath(cacheSuffix);
}
