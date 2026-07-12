import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
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
 * `-lc++`: ada-url (URL parser) wraps the C++ `ada` library, whose objects are
 * bundled into libmal_rust.a, so the final link needs the C++ stdlib. On this
 * macOS/clang toolchain that is libc++ (`-lc++`); a gcc/Linux port would use
 * `-lstdc++`. It is appended ONLY when `webPlatform` is on — with ada gated out
 * (surface.webPlatform: false) there is no C++ to link, so the flag is dropped.
 */
export function rustLinkArgs(cacheSuffix = "", webPlatform = true): Array<string> {
	return webPlatform ? [rustLibPath(cacheSuffix), "-lc++"] : [rustLibPath(cacheSuffix)];
}

const builtConfigs = new Set<string>();

/** Resolve from exactly the caller's PATH; never add package-manager directories. */
export function resolvePathExecutable(
	name: string,
	searchPath = process.env.PATH ?? "",
): string {
	for (const directory of searchPath.split(path.delimiter)) {
		const candidate = path.join(directory || ".", name);
		try {
			const stats = statSync(candidate);
			if (!stats.isFile()) continue;
			// The self-host's minimal Stats omits mode; its isolated PATH contains only
			// symlinks created from executables already resolved by this Node-hosted check.
			if (stats.mode !== undefined && (stats.mode & 0o111) === 0) continue;
			return candidate;
		} catch {
			// Keep searching for a regular executable file.
		}
	}
	throw new Error(`required executable '${name}' was not found on PATH`);
}

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

	const currentPath = process.env.PATH ?? "";
	const rustupPath = resolvePathExecutable("rustup", currentPath);

	// `rustup which cargo`, run inside the crate, honours rust-toolchain.toml and
	// gives us the toolchain bin dir to put on PATH so cargo finds its own rustc
	// (there are no rustup proxies on PATH in this environment).
	const cargoPath = execFileSync(rustupPath, ["which", "cargo"], {
		cwd: RUST_DIR,
		env: { ...process.env, PATH: currentPath },
		encoding: "utf-8",
	}).trim();
	const rustcPath = execFileSync(rustupPath, ["which", "rustc"], {
		cwd: RUST_DIR,
		env: { ...process.env, PATH: currentPath },
		encoding: "utf-8",
	}).trim();
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
			CARGO_HOME,
			CARGO_TARGET_DIR: rustTargetDir(cacheSuffix),
			RUSTC: rustcPath,
		},
		stdio: verbose ? "inherit" : "ignore",
	});

	builtConfigs.add(cacheSuffix);
	return rustLibPath(cacheSuffix);
}
