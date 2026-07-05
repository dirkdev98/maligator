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

/** Where cargo drops the staticlib given our CARGO_TARGET_DIR. */
export const RUST_LIB_PATH = path.join(CARGO_TARGET_DIR, "release", "libmal_rust.a");

/**
 * Final-link arguments for a binary that uses the runtime: the Rust staticlib
 * (which must follow libLibMaligator.a, since the archive references its
 * symbols) plus any platform libraries Rust std / the vendored crates require.
 *
 * The shim links clean on macOS with no frameworks so far. Extend here if a
 * future dependency introduces an undefined-symbol link error.
 *
 * `-lc++`: ada-url (URL parser) wraps the C++ `ada` library, whose objects are
 * bundled into libmal_rust.a, so the final link needs the C++ stdlib. On this
 * macOS/clang toolchain that is libc++ (`-lc++`); a gcc/Linux port would use
 * `-lstdc++`.
 */
export function rustLinkArgs(): Array<string> {
	const args = [RUST_LIB_PATH, "-lc++"];
	return args;
}

let built = false;

/**
 * Build `libmal_rust.a` (release) if not already built this process. Resolves
 * cargo via the rustup-pinned toolchain and routes all caches into `.cache`.
 * Returns the path to the static archive. Cheap to call repeatedly: cargo
 * no-ops when nothing changed.
 */
export function ensureRustLibrary(verbose = false): string {
	if (built) {
		return RUST_LIB_PATH;
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

	execFileSync("cargo", ["build", "--release"], {
		cwd: RUST_DIR,
		env: {
			...process.env,
			PATH: `${toolchainBin}:${pathWithBrew}`,
			CARGO_HOME,
			CARGO_TARGET_DIR,
		},
		stdio: verbose ? "inherit" : "ignore",
	});

	built = true;
	return RUST_LIB_PATH;
}
