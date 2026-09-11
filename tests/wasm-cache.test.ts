import {
	chmodSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { WASI } from "node:wasi";
import { expect, it, vi } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { buildWasmEngine } from "../src/wasm-build.ts";
import { WasmEngine } from "../src/wasm-embedding.ts";

const root = path.resolve(import.meta.dirname, "..");
const config = resolveBuildConfig({
	engine: {
		eval: false,
		realms: false,
		regexp: true,
		temporal: false,
		intl: { enabled: false },
	},
	surface: { node: false, webPlatform: false, maligator: false },
});

function sourceCheckout(directory: string): string {
	mkdirSync(directory, { recursive: true });
	for (const name of ["src", "node_modules", "package.json"])
		symlinkSync(path.join(root, name), path.join(directory, name));
	for (const name of [
		"src",
		"embedding",
		"rust/src",
		"rust/include",
		"rust/Cargo.toml",
		"rust/Cargo.lock",
		"rust/rust-toolchain.toml",
	]) {
		cpSync(path.join(root, "runtime", name), path.join(directory, "runtime", name), {
			recursive: true,
		});
	}
	const bridge = path.join(directory, "runtime/embedding/wasm.c");
	writeFileSync(
		bridge,
		`#include "cache-test.h"\n${readFileSync(bridge, "utf8").replace(
			"int mal_wasm_abi_version(void) { return 1; }",
			"int mal_wasm_abi_version(void) { return MAL_CACHE_ABI; }",
		)}`,
	);
	writeFileSync(
		path.join(directory, "runtime/embedding/cache-test.h"),
		"#define MAL_CACHE_ABI 1\n",
	);
	writeFileSync(
		path.join(directory, "entry.mjs"),
		"globalThis.echo = input => `echo:${input}`;",
	);
	return directory;
}

function instantiate(file: string): WebAssembly.Instance {
	const wasi = new WASI({ version: "preview1", preopens: {}, returnOnExit: true });
	const instance = new WebAssembly.Instance(
		new WebAssembly.Module(readFileSync(file)),
		wasi.getImportObject() as WebAssembly.Imports,
	);
	wasi.initialize(instance);
	return instance;
}

function echo(file: string): string {
	const engine = new WasmEngine(instantiate(file));
	try {
		return engine.call("echo", "🐊");
	} finally {
		engine.dispose();
	}
}

it("shares Wasm stages across paths and invalidates changed sources, includes, flags and tools", () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "mal-wasm-cache-"));
	const cache = path.join(directory, "cache/v1");
	vi.stubEnv("MALIGATOR_CACHE_DIR", path.dirname(cache));
	try {
		const firstRoot = sourceCheckout(path.join(directory, "first"));
		const secondRoot = sourceCheckout(path.join(directory, "second"));
		const build = (sourceRoot: string, buildConfig = config) =>
			buildWasmEngine({
				root: sourceRoot,
				entry: "entry.mjs",
				config: buildConfig,
				output: path.join(sourceRoot, "engine.wasm"),
			});
		const first = build(firstRoot);
		expect(first.counts.reused).toBe(0);
		expect(echo(first.file)).toBe("echo:🐊");
		const second = build(secondRoot);
		expect(second.counts).toEqual({ built: 0, reused: first.counts.built });
		expect(second.digest).toBe(first.digest);
		expect(echo(second.file)).toBe("echo:🐊");

		writeFileSync(
			path.join(secondRoot, "entry.mjs"),
			"globalThis.echo = input => `updated:${input}`;",
		);
		const changedSource = build(secondRoot);
		expect(changedSource.stages["wasm-source"]?.built).toBe(1);
		expect(changedSource.stages["wasm-object"]?.reused).toBeGreaterThan(0);
		expect(changedSource.stages["wasm-object"]?.built).toBeGreaterThan(0);
		expect(changedSource.stages["wasm-archive"]?.reused).toBe(1);
		expect(echo(changedSource.file)).toBe("updated:🐊");

		const bridge = path.join(secondRoot, "runtime/embedding/wasm.c");
		writeFileSync(
			bridge,
			readFileSync(bridge, "utf8").replace(
				"return MAL_CACHE_ABI;",
				"return MAL_CACHE_ABI + 1;",
			),
		);
		const changedC = build(secondRoot);
		expect(changedC.stages["wasm-object"]?.built).toBe(1);
		expect(changedC.stages["wasm-archive"]?.reused).toBe(1);
		expect(
			(instantiate(changedC.file).exports.mal_wasm_abi_version as () => number)(),
		).toBe(2);

		writeFileSync(
			path.join(secondRoot, "runtime/embedding/cache-test.h"),
			"#define MAL_CACHE_ABI 3\n",
		);
		const changedHeader = build(secondRoot);
		expect(changedHeader.stages["wasm-object"]?.reused).toBe(0);
		expect(changedHeader.stages["wasm-source"]?.reused).toBe(1);
		expect(changedHeader.stages["wasm-rust"]?.reused).toBe(1);
		expect(
			(instantiate(changedHeader.file).exports.mal_wasm_abi_version as () => number)(),
		).toBe(4);

		const include = path.join(
			secondRoot,
			"runtime/src/generated/known_native_entries.inc",
		);
		writeFileSync(
			include,
			`${readFileSync(include, "utf8")}\n#define MAL_CACHE_INCLUDE_REVISION 1\n`,
		);
		const changedInclude = build(secondRoot);
		expect(changedInclude.stages["wasm-object"]?.reused).toBe(0);
		expect(changedInclude.stages["wasm-source"]?.reused).toBe(1);

		const changedFlags = build(secondRoot, {
			...config,
			engine: { ...config.engine, regexp: false },
		});
		expect(changedFlags.stages["wasm-object"]?.reused).toBe(0);
		expect(changedFlags.stages["wasm-rust"]?.built).toBe(1);
		expect(readdirSync(path.join(cache, "work/wasm-rust"))).toHaveLength(1);
		vi.stubEnv("CARGO_BUILD_JOBS", "1");
		expect(build(firstRoot).counts.built).toBe(0);
		vi.stubEnv("CARGO_BUILD_JOBS", "2");
		const restored = build(firstRoot);
		expect(restored.counts.built).toBe(0);
		expect(restored.digest).toBe(first.digest);
		expect(echo(restored.file)).toBe("echo:🐊");

		const zig = path.join(directory, "zig");
		writeFileSync(
			zig,
			`#!/bin/sh\nexec '${first.toolchain.tools.zig.path.replaceAll("'", "'\\''")}' "$@"\n`,
		);
		chmodSync(zig, 0o755);
		vi.stubEnv("ZIG", zig);
		const changedTool = build(firstRoot);
		expect(changedTool.toolchain.fingerprint).not.toBe(first.toolchain.fingerprint);
		expect(changedTool.stages["wasm-object"]?.reused).toBe(0);
		expect(changedTool.stages["wasm-rust"]?.built).toBe(1);
		expect(changedTool.stages["wasm-source"]?.reused).toBe(1);
		expect(echo(changedTool.file)).toBe("echo:🐊");
		expect(readdirSync(path.join(cache, "work/wasm"))).toEqual([]);
	} finally {
		vi.unstubAllEnvs();
		rmSync(directory, { recursive: true, force: true });
	}
}, 300_000);
