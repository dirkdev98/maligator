import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { CommandProgress } from "../src/command-progress.ts";
import { resolvePathExecutable } from "../src/toolchain.ts";

function selectedRustTool(rustup: string, name: "cargo" | "rustc", cwd: string): string {
	const selected = spawnSync(rustup, ["which", name], { cwd, encoding: "utf8" });
	if (selected.error !== undefined) throw selected.error;
	if (selected.status !== 0 || selected.stdout.trim().length === 0) {
		throw new Error(
			selected.stderr.trim() || `rustup could not select ${name} for runtime/rust`,
		);
	}
	return selected.stdout.trim();
}

export function runRustTests(args = process.argv.slice(2)): number {
	const root = path.resolve(import.meta.dirname, "..");
	const progress = new CommandProgress("test-rust");
	progress.stage(1, 2, "resolve pinned Rust tools");
	const rustDirectory = path.join(root, "runtime/rust");
	const rustup = resolvePathExecutable("rustup");
	const cargo = selectedRustTool(rustup, "cargo", rustDirectory);
	const rustc = selectedRustTool(rustup, "rustc", rustDirectory);
	progress.stagePassed(1, 2, "resolve pinned Rust tools");
	progress.stage(2, 2, "run Rust tests");
	const result = spawnSync(
		cargo,
		[
			"test",
			"--manifest-path",
			path.join(rustDirectory, "Cargo.toml"),
			"--locked",
			"--features",
			"node-argon2,node-zlib",
			...args,
		],
		{
			cwd: root,
			stdio: "inherit",
			env: {
				...process.env,
				PATH: `${path.dirname(cargo)}${path.delimiter}${process.env.PATH ?? ""}`,
				CARGO_HOME: path.join(root, ".cache/mal-cache/cargo"),
				CARGO_TARGET_DIR: path.join(root, ".cache/mal-build/rust-tests"),
				RUSTC: rustc,
			},
		},
	);
	if (result.error !== undefined) throw result.error;
	if (result.status === 0) {
		progress.stagePassed(2, 2, "run Rust tests");
		progress.complete();
	} else {
		progress.stageFailed(2, 2, "run Rust tests");
	}
	return result.status ?? 1;
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	process.exitCode = runRustTests();
}
