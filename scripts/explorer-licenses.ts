import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { WasmToolchain } from "../src/toolchain.ts";

export function explorerLicenses(toolchain: WasmToolchain): string {
	const notices: Array<[string, string]> = [
		["Maligator", "LICENSE"],
		["Meriyah", "node_modules/meriyah/LICENSE.md"],
		[
			"browser_wasi_shim (MIT option)",
			"node_modules/@bjorn3/browser_wasi_shim/LICENSE-MIT",
		],
	];
	const metadata = JSON.parse(
		execFileSync(
			toolchain.tools.cargo.path,
			[
				"metadata",
				"--manifest-path",
				"runtime/rust/Cargo.toml",
				"--format-version",
				"1",
				"--locked",
				"--offline",
				"--no-default-features",
				"--features",
				"regexp",
				"--filter-platform",
				"wasm32-wasip1",
			],
			{ encoding: "utf8", env: { ...process.env, RUSTC: toolchain.tools.rustc.path } },
		),
	) as {
		packages: Array<{
			name: string;
			version: string;
			source: string | null;
			license: string;
			manifest_path: string;
		}>;
	};
	for (const pkg of metadata.packages) {
		if (pkg.source === null) continue;
		const directory = path.dirname(pkg.manifest_path);
		const files = readdirSync(directory).filter((file) =>
			/^(?:LICENSE|COPYING|NOTICE|UNLICENSE)/i.test(file),
		);
		if (files.length === 0) throw new Error(`Missing license notice for ${pkg.name}`);
		for (const file of files)
			notices.push([
				`${pkg.name} ${pkg.version} (${pkg.license})`,
				path.join(directory, file),
			]);
	}
	const rustDocs = path.resolve(toolchain.tools.rustc.path, "../../share/doc/rust");
	notices.push([
		"Rust standard library and bundled dependencies",
		path.join(rustDocs, "COPYRIGHT-library.html"),
	]);
	const zigEnvironment = execFileSync(toolchain.tools.zig.path, ["env"], {
		encoding: "utf8",
	});
	const libDirectory = /\.lib_dir = ("(?:[^"\\]|\\.)*")/.exec(zigEnvironment)?.[1];
	if (libDirectory === undefined)
		throw new Error("Zig did not report its library directory");
	const wasi = path.join(JSON.parse(libDirectory) as string, "libc/wasi");
	for (const file of [
		"LICENSE",
		"LICENSE-MIT",
		"LICENSE-APACHE",
		"LICENSE-APACHE-LLVM",
		"libc-bottom-half/cloudlibc/LICENSE",
		"libc-top-half/musl/COPYRIGHT",
	])
		notices.push([`WASI libc: ${file}`, path.join(wasi, file)]);
	return notices
		.map(([name, file]) => `${name}\n${readFileSync(file, "utf8")}`)
		.join("\n\n");
}
