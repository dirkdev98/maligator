import { execFileSync } from "node:child_process";
import * as path from "node:path";

/**
 * Build + link integration for the `mal_i18n` Rust shim (ICU4X / temporal_rs).
 *
 * The shim is a `staticlib` that the C runtime links against for Date timezone
 * offsets and the whole Intl surface. We drive cargo through rustup so the
 * pinned toolchain (runtime/i18n/rust-toolchain.toml) is honoured, and we keep
 * every cargo artifact under the gitignored `.cache` (mirroring test262), so a
 * clean checkout never carries build output.
 *
 * Centralising the lib path + link args here means that when ICU4X/temporal
 * pull in std features that need extra macOS frameworks, only `i18nLinkArgs`
 * changes — not the four cc link sites that consume it.
 */

const I18N_DIR = "runtime/i18n";

/** Passed to cc as `-I` so runtime/src/*.c can `#include "mal_i18n.h"`. */
export const I18N_INCLUDE_DIR = path.join(I18N_DIR, "include");

/** Project-local cargo home + target dir, both under the gitignored `.cache`. */
const CARGO_HOME = path.resolve(".cache/cargo");
const CARGO_TARGET_DIR = path.resolve(".cache/cargo-target");

/** Where cargo drops the staticlib given our CARGO_TARGET_DIR. */
export const I18N_LIB_PATH = path.join(CARGO_TARGET_DIR, "release", "libmal_i18n.a");

/**
 * Final-link arguments for a binary that uses the runtime: the Rust staticlib
 * (which must follow libLibMaligator.a, since the archive references its
 * symbols) plus any platform libraries Rust std / the i18n crates require.
 *
 * The bare shim links clean on macOS with no frameworks; ICU4X/temporal_rs add
 * none that aren't already pulled by libSystem so far. Extend here if a future
 * dependency introduces an undefined-symbol link error.
 */
export function i18nLinkArgs(): Array<string> {
	const args = [I18N_LIB_PATH];
	return args;
}

let built = false;

/**
 * Build `libmal_i18n.a` (release) if not already built this process. Resolves
 * cargo via the rustup-pinned toolchain and routes all caches into `.cache`.
 * Returns the path to the static archive. Cheap to call repeatedly: cargo
 * no-ops when nothing changed.
 */
export function ensureI18nLibrary(verbose = false): string {
	if (built) {
		return I18N_LIB_PATH;
	}

	const pathWithBrew = `/opt/homebrew/bin:${process.env.PATH ?? ""}`;

	// `rustup which cargo`, run inside the crate, honours rust-toolchain.toml and
	// gives us the toolchain bin dir to put on PATH so cargo finds its own rustc
	// (there are no rustup proxies on PATH in this environment).
	const cargoPath = execFileSync("rustup", ["which", "cargo"], {
		cwd: I18N_DIR,
		env: { ...process.env, PATH: pathWithBrew },
		encoding: "utf-8",
	}).trim();
	const toolchainBin = path.dirname(cargoPath);

	execFileSync("cargo", ["build", "--release"], {
		cwd: I18N_DIR,
		env: {
			...process.env,
			PATH: `${toolchainBin}:${pathWithBrew}`,
			CARGO_HOME,
			CARGO_TARGET_DIR,
		},
		stdio: verbose ? "inherit" : "ignore",
	});

	built = true;
	return I18N_LIB_PATH;
}
