import { spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { normalizeNativeFeatures, selectNativeBuildPlan } from "../src/build-flags.ts";
import { cargoCacheDirectory, maligatorCacheDirectory } from "../src/cache-root.ts";
import { ensureCompilerWire } from "../src/compiler-bake.ts";
import { buildLocalBinary } from "../src/local-build.ts";
import {
	nativeBuildEnvironmentFingerprint,
	resolveNativeBuildContext,
} from "../src/native-build-context.ts";
import type { NativeBuildContext } from "../src/native-build-context.ts";
import { nativeBuildJobs, runNativeCommands } from "../src/native-command.ts";
import {
	compilerNativeOverlayEnabled,
	ensureNativeArtifacts,
	runtimeArtifactKey,
	runtimeHeaderHash,
} from "../src/runtime-build.ts";
import { ensureRustArtifacts, resolveRustArtifacts } from "../src/rust-build.ts";
import { runToStdout } from "../src/test-harness.ts";
import {
	formatToolchainReport,
	inspectToolchain,
	requireWasmToolchain,
} from "../src/toolchain.ts";
import type { ToolchainReport } from "../src/toolchain.ts";

interface FakeToolchain {
	root: string;
	bin: string;
	rustDir: string;
	logPath: string;
	env: NodeJS.ProcessEnv;
}

describe("native compiler overlay policy", () => {
	it("keeps sanitizer and profiling builds on the compiler wire", () => {
		expect(compilerNativeOverlayEnabled(false, {})).toBe(true);
		expect(compilerNativeOverlayEnabled(true, {})).toBe(false);
		expect(compilerNativeOverlayEnabled(false, { MAL_UBSAN: "1" })).toBe(false);
		expect(compilerNativeOverlayEnabled(false, { MAL_ASAN: "1" })).toBe(false);
	});
});

function executable(filePath: string, body: string): void {
	writeFileSync(filePath, `#!/bin/sh\n${body}`);
	chmodSync(filePath, 0o755);
}

it("reports native process failures immediately with the termination reason", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "mal-native-failure-"));
	const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
	try {
		const binary = path.join(root, "child");
		executable(binary, "exit 7\n");
		expect(() => runToStdout(binary)).toThrow("exited with status 7");
		expect(stderr).toHaveBeenCalledWith(expect.stringContaining("exited with status 7"));
		executable(binary, "exec /bin/sleep 1\n");
		expect(() =>
			runToStdout(binary, {
				timeoutMs: 50,
				env: { MAL_ASAN: "0", MAL_UBSAN: "0", MAL_GC_STRESS: "0" },
			}),
		).toThrow("timed out after 50ms");
		expect(stderr).toHaveBeenCalledWith(expect.stringContaining("timed out after 50ms"));
	} finally {
		stderr.mockRestore();
		rmSync(root, { recursive: true, force: true });
	}
});

it("rejects Wasm compilers without the LLVM reachability fix", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "mal-wasm-toolchain-"));
	try {
		const bin = path.join(root, "bin");
		mkdirSync(bin);
		executable(path.join(bin, "clang"), "echo 'clang version 22.1.0-wasi-sdk'\n");
		executable(path.join(bin, "llvm-ar"), "echo 'LLVM version 22.1.0'\n");
		expect(() => requireWasmToolchain(root, { WASI_SDK_PATH: root, PATH: "" })).toThrow(
			"require LLVM 23 or newer",
		);
		expect(() => requireWasmToolchain(root, { PATH: bin })).toThrow("set WASI_SDK_PATH");
		executable(path.join(bin, "clang"), "echo 'clang version 24.1.0-wasi-sdk'\n");
		writeFileSync(path.join(root, "VERSION"), "35.0\n");
		expect(() => requireWasmToolchain(root, { WASI_SDK_PATH: root, PATH: "" })).toThrow(
			"pinned WASI SDK 34.0",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

function compilerScript(
	version: string,
	logPath: string,
	lto = true,
	thinLto = true,
): string {
	return `
printf '%s\n' "$*" >> '${logPath}'
printf 'cc-env %s\n' "$MAL_TEST_BUILD_ENV" >> '${logPath}'
if [ "$1" = "--version" ]; then printf '%s\n' '${version}'; exit 0; fi
if [ "$1" = "-dumpmachine" ]; then printf '%s\n' 'fake-target'; exit 0; fi
${thinLto ? "" : 'case " $* " in *" -flto=thin "*) exit 1;; esac'}
${lto ? "" : 'case " $* " in *" -flto"*) exit 1;; esac'}
invocation="$*"
out=''
preprocess=''
source=''
while [ "$#" -gt 0 ]; do
	if [ "$1" = "-E" ]; then preprocess=1; fi
	case "$1" in *.c) source="$1";; esac
	if [ "$1" = "-o" ]; then shift; out="$1"; fi
	shift
done
if [ -n "$out" ]; then
	if [ -n "$preprocess" ] && [ -n "$source" ]; then /bin/cat "$source" > "$out"
	else printf '%s' "$invocation" > "$out"; /bin/chmod +x "$out"
	fi
fi
exit 0
`;
}

function createFakeToolchain(
	options: { lto?: boolean; thinLto?: boolean; strip?: boolean } = {},
): FakeToolchain {
	const root = mkdtempSync(path.join(os.tmpdir(), "mal-toolchain-"));
	const bin = path.join(root, "bin");
	const rustDir = path.join(root, "runtime/rust");
	const rustTargetLib = path.join(root, "rust-targets/x86_64-unknown-linux-gnu/lib");
	const logPath = path.join(root, "cc.log");
	mkdirSync(bin);
	mkdirSync(rustDir, { recursive: true });
	mkdirSync(rustTargetLib, { recursive: true });
	writeFileSync(logPath, "");

	executable(
		path.join(bin, "fake-cc"),
		compilerScript("fake cc 1", logPath, options.lto ?? true, options.thinLto ?? true),
	);
	executable(path.join(bin, "fake-cxx"), compilerScript("fake cxx 1", logPath));
	executable(
		path.join(bin, "ar"),
		`if [ "$1" = "--version" ]; then printf '%s\\n' "fake ar 1"; exit 0; fi
printf 'ar %s\\n' "$*" >> '${logPath}'
printf 'ar-env %s\\n' "$MAL_TEST_BUILD_ENV" >> '${logPath}'
printf '!<arch>\\n' > "$2"
`,
	);
	executable(
		path.join(bin, "zig"),
		`printf 'zig %s\\n' "$*" >> '${logPath}'
if [ "$1" = "version" ]; then printf '%s\\n' "0.15.2"; exit 0; fi
subcommand="$1"
shift
if [ "$subcommand" = "cc" ] || [ "$subcommand" = "c++" ]; then
	if [ "$1" = "-target" ]; then zig_target="$2"; shift 2; fi
	if [ "$1" = "-dumpmachine" ]; then printf '%s\\n' "$zig_target"; exit 0; fi
	out=''
	while [ "$#" -gt 0 ]; do
		if [ "$1" = "-o" ]; then shift; out="$1"; fi
		shift
	done
	if [ -n "$out" ]; then printf 'x' > "$out"; /bin/chmod +x "$out"; fi
	exit 0
fi
if [ "$subcommand" = "ar" ]; then
	printf '!<arch>\\n' > "$2"
	exit 0
fi
if [ "$subcommand" = "objcopy" ]; then /bin/cp "$2" "$3"; exit 0; fi
exit 1
`,
	);
	executable(
		path.join(bin, "cargo"),
		`if [ "$1" = "--version" ]; then printf '%s\\n' "cargo 1.96.0"; exit 0; fi
printf 'cargo %s\\n' "$*" >> '${logPath}'
printf 'cargo-home %s\\n' "$CARGO_HOME" >> '${logPath}'
printf 'cargo-env %s\\n' "$MAL_TEST_BUILD_ENV" >> '${logPath}'
printf 'cargo-cc %s\\n' "$CC" >> '${logPath}'
printf 'cargo-cxx %s\\n' "$CXX" >> '${logPath}'
printf 'cargo-ar %s\\n' "$AR" >> '${logPath}'
cargo_output="$CARGO_TARGET_DIR/release"
while [ "$#" -gt 0 ]; do
	if [ "$1" = "--target" ]; then shift; cargo_output="$CARGO_TARGET_DIR/$1/release"; fi
	shift
done
/bin/mkdir -p "$cargo_output"
printf '!<arch>\\n' > "$cargo_output/libmal_rust.a"
`,
	);
	executable(
		path.join(bin, "rustc"),
		`if [ "$1" = "--version" ]; then printf '%s\\n' "rustc 1.96.0"
elif [ "$1" = "-vV" ]; then printf '%s\\n' "rustc 1.96.0" "host: fake-rust-target"
elif [ "$1" = "--print" ] && [ "$2" = "target-libdir" ] && [ "$4" = "x86_64-unknown-linux-gnu" ]; then printf '%s\\n' '${rustTargetLib}'
else exit 1
fi
`,
	);
	executable(
		path.join(bin, "rustup"),
		`if [ "$1" = "--version" ]; then printf '%s\\n' "rustup 1.28"; elif [ "$1" = "which" ]; then printf '%s\\n' '${bin}/'$2; fi\n`,
	);
	executable(
		path.join(bin, "strip"),
		`if [ "$1" = "--version" ]; then printf '%s\\n' "fake strip 1"; exit 0; fi
printf 'strip %s\\n' "$*" >> '${logPath}'
${options.strip === false ? "exit 1" : "exit 0"}
`,
	);
	return {
		root,
		bin,
		rustDir,
		logPath,
		env: { PATH: bin, CC: "fake-cc", CXX: "fake-cxx" },
	};
}

function createMinimalRuntime(fake: FakeToolchain): string {
	const runtimeDirectory = path.join(fake.root, "runtime");
	for (const directory of [
		path.join(runtimeDirectory, "src/host"),
		path.join(runtimeDirectory, "src/runtime"),
		path.join(runtimeDirectory, "rust/include"),
		path.join(runtimeDirectory, "rust/src"),
	]) {
		mkdirSync(directory, { recursive: true });
	}
	writeFileSync(path.join(runtimeDirectory, "src/engine.c"), "int engine_value = 1;\n");
	writeFileSync(path.join(runtimeDirectory, "src/host/host.c"), "int host_value = 1;\n");
	writeFileSync(
		path.join(runtimeDirectory, "src/runtime/runtime.c"),
		"int runtime_value = 1;\n",
	);
	writeFileSync(
		path.join(runtimeDirectory, "test262_main.c"),
		"int main(void) { return 0; }\n",
	);
	writeFileSync(path.join(runtimeDirectory, "rust/include/mal.h"), "#pragma once\n");
	writeFileSync(
		path.join(runtimeDirectory, "rust/Cargo.toml"),
		'[package]\nname = "mal_rust"\nversion = "0.0.0"\n',
	);
	writeFileSync(
		path.join(runtimeDirectory, "rust/src/lib.rs"),
		"pub fn value() -> i32 { 1 }\n",
	);
	return runtimeDirectory;
}

function compileInvocationCount(logPath: string): number {
	return readFileSync(logPath, "utf-8")
		.split("\n")
		.filter((line) => line.includes(" -c ")).length;
}

describe("native toolchain discovery", () => {
	it("runs independent native commands with bounded concurrency", () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "mal-native-command-pool-"));
		const quotedRoot = path.join(root, "quoted'path");
		mkdirSync(quotedRoot);
		const runner = path.join(quotedRoot, "barrier");
		const checker = path.join(quotedRoot, "checker");
		const first = path.join(quotedRoot, "first");
		const second = path.join(quotedRoot, "second");
		const firstDone = path.join(quotedRoot, "first-done");
		const secondDone = path.join(quotedRoot, "second-done");
		const third = path.join(quotedRoot, "third");
		const fourth = path.join(quotedRoot, "fourth");
		executable(
			runner,
			`/usr/bin/touch "$1"
i=0
while [ "$i" -lt 100 ]; do
	if [ -f "$2" ]; then /usr/bin/touch "$3"; exit 0; fi
	i=$((i + 1))
	/bin/sleep 0.01
done
exit 7
`,
		);
		executable(
			checker,
			`[ -f "$1" ] || exit 8
/usr/bin/touch "$2"
`,
		);
		const commands: Array<string> = [];
		const environment = {
			...process.env,
			MALIGATOR_WORKERS: "2",
			MAL_BUILD_JOBS: "2",
		};
		const context = {
			environment,
			onCommand: (command: { tool: string }) => {
				commands.push(command.tool);
			},
		} as unknown as NativeBuildContext;
		runNativeCommands(
			context,
			[
				{ tool: runner, args: [first, second, firstDone] },
				{ tool: runner, args: [second, first, secondDone] },
				{ tool: checker, args: [firstDone, third] },
				{ tool: checker, args: [secondDone, fourth] },
			],
			{ verbose: false, env: environment },
		);
		expect(existsSync(first)).toBe(true);
		expect(existsSync(second)).toBe(true);
		expect(existsSync(third)).toBe(true);
		expect(existsSync(fourth)).toBe(true);
		expect(commands).toEqual([runner, runner, checker, checker]);
		expect(nativeBuildJobs(environment)).toBe(2);
		expect(() => nativeBuildJobs({ MAL_BUILD_JOBS: "0" })).toThrow(
			"MAL_BUILD_JOBS must be a positive integer",
		);
	});

	it("honors CC/CXX and resolves the rustup-selected pinned tools", () => {
		const fake = createFakeToolchain();
		const report = inspectToolchain({
			rootDir: fake.root,
			rustDir: fake.rustDir,
			env: fake.env,
			platform: "linux",
			arch: "x64",
		});

		expect(report.toolchain).toBeDefined();
		expect(report.tools.cc?.path).toBe(realpathSync(path.join(fake.bin, "fake-cc")));
		expect(report.tools.cxx?.path).toBe(realpathSync(path.join(fake.bin, "fake-cxx")));
		expect(report.tools.cargo?.path).toBe(realpathSync(path.join(fake.bin, "cargo")));
		expect(report.tools.rustc?.path).toBe(realpathSync(path.join(fake.bin, "rustc")));
		expect(report.target).toBe("fake-target");
		expect(report.rustTarget).toBe("fake-rust-target");
		expect(report.probes).toMatchObject({
			c2x: true,
			lto: true,
			ltoFlags: ["-flto=thin"],
			strip: true,
			cxxLink: true,
		});
		const summary = formatToolchainReport(report, "linux");
		expect(summary).toContain("[ok] C compiler");
		expect(summary).toContain("[ok] Rust compiler");
		expect(formatToolchainReport(report, "linux", true)).toContain("fake cc 1");
	});

	it("cross-builds C, C++, archives, Rust, and the final link through Zig", () => {
		const fake = createFakeToolchain();
		const runtimeDirectory = createMinimalRuntime(fake);
		const rustTarget = "x86_64-unknown-linux-gnu";
		const report = inspectToolchain({
			rootDir: fake.root,
			rustDir: path.join(runtimeDirectory, "rust"),
			env: { ...fake.env, CC: "missing-native-cc", CXX: "missing-native-cxx" },
			needsCxx: true,
			platform: "darwin",
			arch: "arm64",
			target: rustTarget,
		});

		expect(report.toolchain).toBeDefined();
		expect(report).toMatchObject({
			cross: true,
			platform: "linux",
			rustTarget,
			zigTarget: "x86_64-linux-gnu",
		});
		const toolchain = report.toolchain!;
		expect(toolchain.tools.cc.args).toEqual(["cc", "-target", "x86_64-linux-gnu"]);
		expect(toolchain.tools.ar.args).toEqual(["ar"]);
		expect(toolchain.tools.cxx?.args).toEqual(["c++", "-target", "x86_64-linux-gnu"]);
		expect(toolchain.tools.strip?.args).toEqual(["objcopy"]);
		expect(toolchain.probes.stripArgs).toEqual(["-s"]);
		expect(formatToolchainReport(report, "linux", true)).toContain(
			"build mode: Zig cross-build",
		);

		writeFileSync(fake.logPath, "");
		const context = resolveNativeBuildContext({
			toolchain,
			runtimeDirectory,
			cacheDirectory: path.join(fake.root, "cross-cache"),
			features: { evalEnabled: false, webPlatformEnabled: false },
			production: true,
		});
		expect(context.plan).toMatchObject({ mode: "production", lto: true, strip: true });
		expect(context.environment.ZIG_GLOBAL_CACHE_DIR).toContain(
			path.join(fake.root, ".cache/maligator-test/zig"),
		);
		const artifacts = resolveRustArtifacts(context);
		expect(artifacts.cargoArguments).toContain(rustTarget);
		expect(artifacts.library).toContain(
			`${path.sep}${rustTarget}${path.sep}release${path.sep}`,
		);
		expect(artifacts.linkArgs).toEqual([artifacts.library, "-lm", "-lunwind"]);
		expect(artifacts.nativeToolEnvironment).toMatchObject({
			CC_KNOWN_WRAPPER_CUSTOM: "zig",
			CRATE_CC_NO_DEFAULTS: "1",
			CFLAGS: "-fno-sanitize=undefined",
			CXXFLAGS: "-fno-sanitize=undefined",
		});
		const result = buildLocalBinary({
			context,
			name: "cross-output",
			cSource: "int value;",
			verbose: false,
			outDir: path.join(fake.root, "output"),
		});
		expect(result.binaryPath).toBe(path.join(fake.root, "output", "cross-output"));

		const invocations = readFileSync(fake.logPath, "utf-8");
		expect(invocations).toContain("zig cc -target x86_64-linux-gnu");
		expect(invocations).toContain("zig ar rcs");
		expect(invocations).toContain(
			`cargo build --release --no-default-features --target ${rustTarget}`,
		);
		expect(invocations).toContain(
			`cargo-cc ${realpathSync(path.join(fake.bin, "zig"))} cc -target x86_64-linux-gnu`,
		);
		expect(invocations).toContain(
			`cargo-ar ${realpathSync(path.join(fake.bin, "zig"))} ar`,
		);
		expect(invocations).toContain(
			`cargo-cxx ${realpathSync(path.join(fake.bin, "zig"))} c++ -target x86_64-linux-gnu`,
		);
		expect(invocations).toContain(" -lm");
		expect(invocations).toContain(" -s -o ");
		expect(invocations).not.toContain("zig objcopy");
	});

	it("rejects unsupported Zig cross targets before probing tools", () => {
		const fake = createFakeToolchain();
		const report = inspectToolchain({
			rootDir: fake.root,
			rustDir: fake.rustDir,
			env: fake.env,
			target: "x86_64-pc-windows-msvc",
		});
		expect(report.toolchain).toBeUndefined();
		expect(report.issues).toContainEqual(
			expect.objectContaining({
				tool: "target",
				required: true,
			}),
		);
		expect(report.issues.find((issue) => issue.tool === "target")?.message).toContain(
			"unsupported cross-build target",
		);
	});

	it("reports a supported but uninstalled Rust cross target", () => {
		const fake = createFakeToolchain();
		const rustTarget = "aarch64-unknown-linux-gnu";
		const report = inspectToolchain({
			rootDir: fake.root,
			rustDir: fake.rustDir,
			env: fake.env,
			target: rustTarget,
		});
		expect(report.toolchain).toBeUndefined();
		expect(report.issues).toContainEqual(
			expect.objectContaining({ tool: "rust-target", required: true }),
		);
		const formatted = formatToolchainReport(report, "linux", true);
		expect(formatted).toContain(`[missing] rust-target`);
		expect(formatted).toContain(`rustup target add ${rustTarget}`);
	});

	it("caches probes and invalidates when an executable identity/version changes", () => {
		const fake = createFakeToolchain();
		const options = {
			rootDir: fake.root,
			rustDir: fake.rustDir,
			env: fake.env,
			platform: "linux" as const,
			arch: "x64",
		};
		const first = inspectToolchain(options);
		const afterFirst = compileInvocationCount(fake.logPath);
		const second = inspectToolchain(options);
		expect(first.cacheHit).toBe(false);
		expect(second.cacheHit).toBe(true);
		expect(compileInvocationCount(fake.logPath)).toBe(afterFirst);

		executable(path.join(fake.bin, "fake-cc"), compilerScript("fake cc 2", fake.logPath));
		const invalidated = inspectToolchain(options);
		expect(invalidated.cacheHit).toBe(false);
		expect(invalidated.fingerprint).not.toBe(first.fingerprint);
		expect(compileInvocationCount(fake.logPath)).toBeGreaterThan(afterFirst);
	});

	it("requires CXX only for builds that include the C++ web runtime", () => {
		const fake = createFakeToolchain();
		const env = { ...fake.env, CXX: "missing-cxx" };
		const withoutWeb = inspectToolchain({
			rootDir: fake.root,
			rustDir: fake.rustDir,
			env,
			needsCxx: false,
			platform: "linux",
		});
		const withWeb = inspectToolchain({
			rootDir: fake.root,
			rustDir: fake.rustDir,
			env,
			needsCxx: true,
			platform: "linux",
		});

		expect(withoutWeb.toolchain).toBeDefined();
		expect(withWeb.toolchain).toBeUndefined();
		expect(withWeb.issues).toContainEqual(
			expect.objectContaining({ tool: "cxx", required: true }),
		);
	});

	it("passes the selected compiler to runtime compilation and the final native link", () => {
		const fake = createFakeToolchain();
		const report = inspectToolchain({
			rootDir: fake.root,
			rustDir: fake.rustDir,
			env: fake.env,
			needsCxx: false,
			platform: "linux",
		});
		expect(report.toolchain).toBeDefined();
		const toolchain = report.toolchain!;
		const phases: Array<{
			phase: string;
			durationMs: number;
			units?: number;
			bytes?: number;
			cache?: "hit" | "miss";
		}> = [];
		const commands: Array<{ tool: string; args: ReadonlyArray<string> }> = [];
		const commandResources: Array<{ tool: string; peakRssBytes: number }> = [];
		const binaryEvents: Array<{ hit: boolean; path: string }> = [];
		const context = resolveNativeBuildContext({
			toolchain,
			cacheDirectory: path.join(fake.root, "cache"),
			features: {
				evalEnabled: false,
				webPlatformEnabled: false,
			},
			onBuildPhase: (event) => phases.push(event),
			onCommand: (event) => commands.push(event),
			measureCommandResources: true,
			onCommandResource: (event) => commandResources.push(event),
			onCacheEvent: (event) => {
				if (event.artifact === "binary") binaryEvents.push(event);
			},
		});
		const result = buildLocalBinary({
			context,
			name: "fake-output",
			cSource: ["int value;", "int other_value;"],
			verbose: false,
			outDir: fake.root,
		});
		const { binaryPath: binary, artifacts } = result;

		const invocations = readFileSync(fake.logPath, "utf-8");
		expect(result.context).toBe(context);
		expect(artifacts.linkArgs).toEqual([
			...artifacts.c.linkArgs,
			...artifacts.rust.linkArgs,
		]);
		expect(invocations).toContain("runtime/src/vm.c");
		expect(invocations).toContain("ar rcs");
		expect(invocations).toContain(`${binary}.c`);
		expect(invocations).toContain(`${binary}.part-1.c`);
		expect(invocations).toContain(`-o ${binary}`);
		expect(existsSync(`${binary}.c`)).toBe(true);
		expect(phases.map((phase) => phase.phase)).toEqual([
			"runtime C projection",
			"runtime C object compile",
			"runtime C · engine",
			"runtime C · host",
			"runtime C · runtime",
			"runtime",
			"rust",
			"write generated C",
			"generated C objects",
			"link",
			"publish binary",
		]);
		expect(phases.every((phase) => phase.durationMs >= 0)).toBe(true);
		expect(phases.find((phase) => phase.phase === "write generated C")).toMatchObject({
			units: 2,
			bytes: Buffer.byteLength("int value;") + Buffer.byteLength("int other_value;"),
		});
		expect(
			phases.find((phase) => phase.phase === "generated C objects")?.bytes,
		).toBeGreaterThan(0);
		expect(commands.some((command) => command.tool === toolchain.tools.cargo.path)).toBe(
			true,
		);
		expect(
			commands.some(
				(command) =>
					command.tool === toolchain.tools.cc.path && command.args.includes("-c"),
			),
		).toBe(true);
		expect(commandResources.length).toBeGreaterThan(0);
		expect(commandResources.every((event) => event.peakRssBytes > 0)).toBe(true);
		expect(binaryEvents.map((event) => event.hit)).toEqual([false]);

		phases.length = 0;
		commands.length = 0;
		binaryEvents.length = 0;
		writeFileSync(binary, "corrupt");
		writeFileSync(fake.logPath, "");
		buildLocalBinary({
			context,
			name: "fake-output",
			cSource: ["int value;", "int other_value;"],
			verbose: false,
			outDir: fake.root,
		});
		expect(binaryEvents.map((event) => event.hit)).toEqual([true]);
		expect(phases.find((phase) => phase.phase === "link")?.cache).toBe("hit");
		expect(commands).toEqual([]);
		expect(readFileSync(binary, "utf-8")).not.toBe("corrupt");

		writeFileSync(binaryEvents[0]!.path, "corrupt");
		commands.length = 0;
		binaryEvents.length = 0;
		buildLocalBinary({
			context,
			name: "fake-output",
			cSource: ["int value;", "int other_value;"],
			verbose: false,
			outDir: fake.root,
		});
		expect(binaryEvents.map((event) => event.hit)).toEqual([false]);
		expect(commands.some((command) => command.args.includes("-o"))).toBe(true);

		commands.length = 0;
		binaryEvents.length = 0;
		buildLocalBinary({
			context,
			name: "same-content-different-output",
			cSource: ["int value;", "int other_value;"],
			verbose: false,
			outDir: fake.root,
		});
		expect(binaryEvents.map((event) => event.hit)).toEqual([true]);
		expect(
			commands.some(
				(command) => command.args.includes("-o") && !command.args.includes("-c"),
			),
		).toBe(false);
	});

	it("reuses content-addressed generated C objects independently", () => {
		const fake = createFakeToolchain();
		const report = inspectToolchain({
			rootDir: fake.root,
			rustDir: fake.rustDir,
			env: fake.env,
			needsCxx: false,
			platform: "linux",
		});
		const context = resolveNativeBuildContext({
			toolchain: report.toolchain!,
			cacheDirectory: path.join(fake.root, "cache"),
			features: { evalEnabled: false, webPlatformEnabled: false },
		});
		const events: Array<{ hit: boolean; path: string }> = [];
		const build = (secondSource: string) =>
			buildLocalBinary({
				context,
				name: "generated-cache",
				cSource: ["int first_value;", secondSource],
				verbose: false,
				outDir: fake.root,
				onGeneratedObjectCacheEvent: (event) => events.push(event),
			});

		build("int second_value;");
		expect(events.map((event) => event.hit)).toEqual([false, false, false]);

		events.length = 0;
		writeFileSync(fake.logPath, "");
		build("int second_value;");
		expect(events.map((event) => event.hit)).toEqual([true, true, true]);
		expect(readFileSync(fake.logPath, "utf-8")).not.toContain(" -c ");

		writeFileSync(events[0]!.path, "corrupt");
		events.length = 0;
		build("int second_value;");
		expect(events.map((event) => event.hit)).toEqual([false, true, true]);

		events.length = 0;
		build("int changed_value;");
		expect(events.map((event) => event.hit)).toEqual([true, false, true]);
	});

	it("uses one production plan for archive/final LTO and post-link stripping", () => {
		const fake = createFakeToolchain();
		const report = inspectToolchain({
			rootDir: fake.root,
			rustDir: fake.rustDir,
			env: fake.env,
			needsCxx: false,
			platform: "linux",
		});
		expect(report.toolchain).toBeDefined();
		const toolchain = report.toolchain!;
		const production = selectNativeBuildPlan(toolchain, true);
		const context = resolveNativeBuildContext({
			toolchain,
			plan: production,
			cacheDirectory: path.join(fake.root, "cache"),
			features: {
				evalEnabled: false,
				webPlatformEnabled: false,
				intlFeatures: ["intl-segmenter"],
			},
		});
		writeFileSync(fake.logPath, "");
		const { binaryPath: binary } = buildLocalBinary({
			context,
			name: "production-output",
			cSource: "int value;",
			verbose: false,
			outDir: fake.root,
		});

		const invocations = readFileSync(fake.logPath, "utf-8");
		expect(invocations).toMatch(/-O2 -g0 -flto=thin .*runtime\/src\/vm\.c/);
		expect(invocations).toContain(`-O2 -g0 -flto=thin`);
		expect(invocations).toContain(`strip --strip-all ${binary}`);
		const compilations = invocations.split("\n").filter((line) => line.includes(" -c "));
		expect(compilations.length).toBeGreaterThan(0);
		for (const invocation of compilations) {
			for (const define of context.features.cDefines) {
				expect(invocation.split(" ")).toContain(define);
			}
		}

		writeFileSync(fake.logPath, "");
		buildLocalBinary({
			context,
			name: "production-output",
			cSource: "int value;",
			verbose: false,
			outDir: fake.root,
		});
		expect(readFileSync(fake.logPath, "utf-8")).toBe("");
	});

	it("keeps the binary but never caches a failed post-link strip", () => {
		const fake = createFakeToolchain();
		const { toolchain } = inspectToolchain({
			rootDir: fake.root,
			rustDir: fake.rustDir,
			env: fake.env,
			needsCxx: false,
			platform: "linux",
		});
		expect(toolchain).toBeDefined();
		expect(toolchain!.probes.strip).toBe(true);
		executable(toolchain!.tools.strip!.path, "exit 1\n");
		const binaryHits: Array<boolean> = [];
		const warnings: Array<string> = [];
		const context = resolveNativeBuildContext({
			toolchain: toolchain!,
			production: true,
			cacheDirectory: path.join(fake.root, "cache"),
			features: { evalEnabled: false, webPlatformEnabled: false },
			onCacheEvent: (event) => {
				if (event.artifact === "binary") binaryHits.push(event.hit);
			},
		});
		for (let attempt = 0; attempt < 2; attempt++) {
			const { binaryPath } = buildLocalBinary({
				context,
				name: "strip-failure",
				cSource: "int value;",
				verbose: false,
				outDir: fake.root,
				onWarning: (warning) => warnings.push(warning),
			});
			expect(existsSync(binaryPath)).toBe(true);
		}
		expect(binaryHits).toEqual([false, false]);
		expect(warnings).toHaveLength(2);
		for (const warning of warnings) {
			expect(warning).toContain("symbol stripping failed after a successful probe");
		}
	});

	it("keeps development at O2 unstripped and falls back when production options fail probes", () => {
		const fake = createFakeToolchain({ lto: false, strip: false });
		const report = inspectToolchain({
			rootDir: fake.root,
			rustDir: fake.rustDir,
			env: fake.env,
			needsCxx: false,
			platform: "linux",
		});
		expect(report.toolchain).toBeDefined();
		const toolchain = report.toolchain!;
		const development = selectNativeBuildPlan(toolchain, false);
		const production = selectNativeBuildPlan(toolchain, true);
		expect(development).toMatchObject({ lto: false, strip: false, warnings: [] });
		expect(production).toMatchObject({ lto: false, strip: false });
		expect(production.warnings.join("\n")).toMatch(/LTO.*unsupported/);
		expect(production.warnings.join("\n")).toMatch(/stripping.*unsupported/);

		writeFileSync(fake.logPath, "");
		const developmentContext = resolveNativeBuildContext({
			toolchain,
			plan: development,
			cacheDirectory: path.join(fake.root, "development-cache"),
			features: { evalEnabled: false, webPlatformEnabled: false },
		});
		buildLocalBinary({
			context: developmentContext,
			name: "development-output",
			cSource: "int value;",
			verbose: false,
			outDir: fake.root,
		});
		const developmentInvocation = readFileSync(fake.logPath, "utf-8");
		expect(developmentInvocation).toContain("-O2 -g0");
		expect(developmentInvocation).not.toContain("-flto");
		expect(developmentInvocation).not.toContain("strip ");

		writeFileSync(fake.logPath, "");
		const productionContext = resolveNativeBuildContext({
			toolchain,
			plan: production,
			cacheDirectory: path.join(fake.root, "production-cache"),
			features: { evalEnabled: false, webPlatformEnabled: false },
		});
		buildLocalBinary({
			context: productionContext,
			name: "fallback-output",
			cSource: "int value;",
			verbose: false,
			outDir: fake.root,
		});
		const invocation = readFileSync(fake.logPath, "utf-8");
		expect(invocation).toContain("-O2 -g0");
		expect(invocation).not.toContain("-flto");
		expect(invocation).not.toContain("strip ");
	}, 10_000);

	it("falls back to full LTO when ThinLTO is unavailable", () => {
		const fake = createFakeToolchain({ thinLto: false });
		const report = inspectToolchain({
			rootDir: fake.root,
			rustDir: fake.rustDir,
			env: fake.env,
			needsCxx: false,
			platform: "linux",
		});
		expect(report.probes).toMatchObject({ lto: true, ltoFlags: ["-flto"] });
		expect(selectNativeBuildPlan(report.toolchain!, true)).toMatchObject({
			lto: true,
			ltoFlags: ["-flto"],
		});
	});

	it("separates runtime cache keys by source, config, toolchain, and environment", () => {
		const base = {
			compileArguments: ["-std=c2x", "-O2", "-c", "<source>"],
			environmentFingerprint: "environment-a",
			sourceHash: "source-a",
			toolchainFingerprint: "toolchain-a",
			target: "target-a",
		};
		const key = runtimeArtifactKey(base);
		expect(runtimeArtifactKey({ ...base, sourceHash: "source-b" })).not.toBe(key);
		expect(runtimeArtifactKey({ ...base, compilerWireDigest: "wire-a" })).not.toBe(key);
		expect(runtimeArtifactKey({ ...base, compilerNativeDigest: "native-a" })).not.toBe(
			key,
		);
		expect(
			runtimeArtifactKey({
				...base,
				compileArguments: [...base.compileArguments, "-DOTHER"],
			}),
		).not.toBe(key);
		expect(runtimeArtifactKey({ ...base, toolchainFingerprint: "toolchain-b" })).not.toBe(
			key,
		);
		expect(
			runtimeArtifactKey({ ...base, environmentFingerprint: "environment-b" }),
		).not.toBe(key);
		const development = { ...base, mode: "development" };
		const production = { ...base, mode: "production" };
		expect(runtimeArtifactKey(development)).toBe(runtimeArtifactKey(production));
	});

	it("keys generated objects by runtime headers rather than implementations", () => {
		const fake = createFakeToolchain();
		const runtimeDirectory = createMinimalRuntime(fake);
		const initial = runtimeHeaderHash(runtimeDirectory, false);

		writeFileSync(path.join(runtimeDirectory, "src/engine.c"), "int engine_value = 2;\n");
		expect(runtimeHeaderHash(runtimeDirectory, false)).toBe(initial);

		writeFileSync(
			path.join(runtimeDirectory, "rust/include/mal.h"),
			"#define MAL_ABI 2\n",
		);
		expect(runtimeHeaderHash(runtimeDirectory, false)).not.toBe(initial);
		const afterHeader = runtimeHeaderHash(runtimeDirectory, false);
		const include = path.join(runtimeDirectory, "src/generated/entries.inc");
		mkdirSync(path.dirname(include), { recursive: true });
		writeFileSync(include, "ENTRY(first)\n");
		const afterInclude = runtimeHeaderHash(runtimeDirectory, false);
		expect(afterInclude).not.toBe(afterHeader);
		writeFileSync(include, "ENTRY(other)\n");
		expect(runtimeHeaderHash(runtimeDirectory, false)).not.toBe(afterInclude);
	});

	it("isolates the SQLite amalgamation from runtime header names", () => {
		const fake = createFakeToolchain();
		const runtimeDirectory = createMinimalRuntime(fake);
		const sqliteDirectory = path.join(runtimeDirectory, "vendor/sqlite");
		mkdirSync(sqliteDirectory, { recursive: true });
		writeFileSync(path.join(sqliteDirectory, "sqlite3.c"), "int sqlite_value = 1;\n");
		writeFileSync(path.join(sqliteDirectory, "sqlite3.h"), "#pragma once\n");
		const toolchain = inspectToolchain({
			rootDir: fake.root,
			rustDir: path.join(runtimeDirectory, "rust"),
			env: fake.env,
			needsCxx: false,
			platform: "linux",
		}).toolchain!;
		ensureNativeArtifacts(
			resolveNativeBuildContext({
				toolchain,
				runtimeDirectory,
				cacheDirectory: path.join(fake.root, "sqlite-cache"),
				features: {
					evalEnabled: false,
					nodeEnabled: true,
					webPlatformEnabled: false,
				},
			}),
		);
		const sqliteInvocation = readFileSync(fake.logPath, "utf-8")
			.split("\n")
			.find((line) => line.includes("vendor/sqlite/sqlite3.c"));
		expect(sqliteInvocation).toBeDefined();
		expect(sqliteInvocation).toContain(`-I ${sqliteDirectory}`);
		expect(sqliteInvocation).not.toContain(`-I ${path.join(runtimeDirectory, "src")}`);
	});

	it("fingerprints only build environment and snapshots it for native subprocesses", () => {
		const fake = createFakeToolchain();
		const runtimeDirectory = createMinimalRuntime(fake);
		const toolchain = inspectToolchain({
			rootDir: fake.root,
			rustDir: path.join(runtimeDirectory, "rust"),
			env: fake.env,
			needsCxx: false,
			platform: "linux",
		}).toolchain!;
		const baseFingerprint = nativeBuildEnvironmentFingerprint({
			...fake.env,
			CFLAGS: "-DVALUE=1",
			CARGO_REGISTRIES_PRIVATE_TOKEN: "first-token",
			UNRELATED_SECRET: "first",
		});
		expect(
			nativeBuildEnvironmentFingerprint({
				...fake.env,
				CFLAGS: "-DVALUE=1",
				CARGO_REGISTRIES_PRIVATE_TOKEN: "second-token",
				UNRELATED_SECRET: "second",
			}),
		).toBe(baseFingerprint);
		expect(
			nativeBuildEnvironmentFingerprint({
				...fake.env,
				CFLAGS: "-DVALUE=1",
				MAL_GC_STRESS: "1",
				MAL_GC_VERIFY: "1",
				MAL_GC_THRESHOLD: "64",
			}),
		).toBe(baseFingerprint);
		expect(
			nativeBuildEnvironmentFingerprint({ ...fake.env, CFLAGS: "-DVALUE=2" }),
		).not.toBe(baseFingerprint);

		const environment = { ...fake.env, MAL_TEST_BUILD_ENV: "snapshot" };
		const context = resolveNativeBuildContext({
			toolchain,
			runtimeDirectory,
			cacheDirectory: path.join(fake.root, "snapshot-cache"),
			environment,
			features: { evalEnabled: false, webPlatformEnabled: false },
		});
		environment.MAL_TEST_BUILD_ENV = "mutated";
		ensureNativeArtifacts(context);
		const invocations = readFileSync(fake.logPath, "utf-8");
		expect(invocations).toContain("cc-env snapshot");
		expect(invocations).toContain("ar-env snapshot");
		expect(invocations).toContain("cargo-env snapshot");
	});

	it("invalidates C and Rust keys for relevant environment changes", () => {
		const fake = createFakeToolchain();
		const runtimeDirectory = createMinimalRuntime(fake);
		const toolchain = inspectToolchain({
			rootDir: fake.root,
			rustDir: path.join(runtimeDirectory, "rust"),
			env: fake.env,
			needsCxx: false,
			platform: "linux",
		}).toolchain!;
		const context = (rustflags: string) =>
			resolveNativeBuildContext({
				toolchain,
				runtimeDirectory,
				cacheDirectory: path.join(fake.root, "environment-cache"),
				environment: { ...fake.env, RUSTFLAGS: rustflags },
				features: { evalEnabled: false, webPlatformEnabled: false },
			});
		const first = context("-Copt-level=1");
		const second = context("-Copt-level=2");
		expect(first.environmentFingerprint).not.toBe(second.environmentFingerprint);
		expect(resolveRustArtifacts(first).library).not.toBe(
			resolveRustArtifacts(second).library,
		);
	});

	it("keys Rust artifacts from normalized Cargo inputs", () => {
		const fake = createFakeToolchain();
		const runtimeDirectory = createMinimalRuntime(fake);
		const toolchain = inspectToolchain({
			rootDir: fake.root,
			rustDir: path.join(runtimeDirectory, "rust"),
			env: fake.env,
			needsCxx: false,
			platform: "linux",
		}).toolchain!;
		const plan = selectNativeBuildPlan(toolchain, false);
		const cacheDirectory = path.join(fake.root, "native-cache");
		const first = resolveRustArtifacts(
			resolveNativeBuildContext({
				runtimeDirectory,
				cacheDirectory,
				toolchain,
				plan,
				features: {
					intlFeatures: ["intl-segmenter", "intl-collator", "intl-segmenter"],
					webPlatformEnabled: false,
					regexpEnabled: true,
				},
			}),
		);
		const reordered = resolveRustArtifacts(
			resolveNativeBuildContext({
				runtimeDirectory,
				cacheDirectory,
				toolchain,
				plan,
				features: {
					intlFeatures: ["intl-collator", "intl-segmenter"],
					webPlatformEnabled: false,
					regexpEnabled: true,
				},
			}),
		);
		const different = resolveRustArtifacts(
			resolveNativeBuildContext({
				runtimeDirectory,
				cacheDirectory,
				toolchain,
				plan,
				features: {
					intlFeatures: ["intl-collator"],
					webPlatformEnabled: false,
					regexpEnabled: true,
				},
			}),
		);

		expect(first.cacheKey).toBe(reordered.cacheKey);
		expect(first.cacheKey).not.toBe(different.cacheKey);
		expect(first.targetDirectory).toBe(reordered.targetDirectory);
		expect(first.targetDirectory).toBe(different.targetDirectory);
		expect(first.library).toContain(cacheDirectory);
		expect(first.cargoFeatures).toEqual([
			"intl-collator",
			"intl-segmenter",
			"regexp",
			"temporal",
		]);
		expect(first.cargoArguments).toEqual([
			"build",
			"--release",
			"--no-default-features",
			"--features",
			"intl-collator,intl-segmenter,regexp,temporal",
		]);

		writeFileSync(
			path.join(runtimeDirectory, "rust/src/lib.rs"),
			"pub fn value() -> i32 { 2 }\n",
		);
		const changedSource = resolveRustArtifacts(
			resolveNativeBuildContext({
				runtimeDirectory,
				cacheDirectory,
				toolchain,
				plan,
				features: {
					intlFeatures: ["intl-collator", "intl-segmenter"],
					webPlatformEnabled: false,
					regexpEnabled: true,
				},
			}),
		);
		expect(changedSource.cacheKey).not.toBe(first.cacheKey);
		expect(changedSource.targetDirectory).not.toBe(first.targetDirectory);
	});

	it("derives coherent C defines and Cargo features from one feature spec", () => {
		const features = normalizeNativeFeatures({
			intlFeatures: ["intl-segmenter"],
			webPlatformEnabled: false,
			regexpEnabled: false,
		});
		expect(features.cargoFeatures).toEqual(["intl-segmenter", "temporal"]);
		expect(features.cDefines).toContain("-DMAL_INTL_HAS_COLLATOR=0");
		expect(features.cDefines).toContain("-DMAL_WEB_PLATFORM=0");
		expect(features.cDefines).toContain("-DMAL_REGEXP=0");
		expect(() =>
			normalizeNativeFeatures({
				intlFeatures: ["intl-segmenter"],
				intlServiceDefines: ["-DMAL_INTL_HAS_NUMBER_FORMAT=0"],
			}),
		).toThrow(/different services/);
	});

	it("re-derives backend arrays supplied on a native feature spec", () => {
		const fake = createFakeToolchain();
		const toolchain = inspectToolchain({
			rootDir: fake.root,
			rustDir: fake.rustDir,
			env: fake.env,
			needsCxx: false,
			platform: "linux",
		}).toolchain!;
		const context = resolveNativeBuildContext({
			toolchain,
			features: {
				evalEnabled: false,
				realmsEnabled: false,
				intlEnabled: false,
				webPlatformEnabled: false,
				regexpEnabled: false,
				temporalEnabled: false,
				nodeEnabled: true,
				intlFeatures: [],
				cDefines: ["-DMAL_EVAL=1"],
				cargoFeatures: ["stale"],
			},
		});

		expect(context.features.cDefines).toEqual([
			"-DMAL_EVAL=0",
			"-DMAL_REALMS=0",
			"-DMAL_INTL=0",
			"-DMAL_WEB_PLATFORM=0",
			"-DMAL_REGEXP=0",
			"-DMAL_TEMPORAL=0",
			"-DMAL_NODE=1",
		]);
		expect(context.features.cargoFeatures).toEqual([
			"node-argon2",
			"node-tls",
			"node-zlib",
			"url",
		]);
	});

	it("invalidates changed and incomplete runtime artifacts", () => {
		const fake = createFakeToolchain();
		const runtimeDirectory = createMinimalRuntime(fake);
		const toolchain = inspectToolchain({
			rootDir: fake.root,
			rustDir: path.join(runtimeDirectory, "rust"),
			env: fake.env,
			needsCxx: false,
			platform: "linux",
		}).toolchain!;
		const events: Array<boolean> = [];
		const cacheDirectory = path.join(fake.root, "native-cache");
		const context = resolveNativeBuildContext({
			toolchain,
			runtimeDirectory,
			cacheDirectory,
			features: {
				evalEnabled: false,
				webPlatformEnabled: false,
			},
			compilerBake: {
				kind: "source",
				sourceDirectory: path.resolve("src"),
				entrypoint: path.resolve("src/compiler/pipeline/eval-compiler-entry.mts"),
				bake: () => {
					throw new Error("eval-off build baked the compiler wire");
				},
			},
			onCacheEvent: (event: {
				artifact: "runtime" | "rust" | "binary";
				hit: boolean;
			}) => {
				if (event.artifact === "runtime") events.push(event.hit);
			},
		});
		const first = ensureNativeArtifacts(context);
		expect(first.c.runtime).toContain(cacheDirectory);
		expect(readFileSync(fake.logPath, "utf-8")).toContain(
			`cargo-home ${cargoCacheDirectory(fake.env)}`,
		);
		const afterFirst = compileInvocationCount(fake.logPath);
		expect(ensureNativeArtifacts(context).c.runtime).toBe(first.c.runtime);
		expect(compileInvocationCount(fake.logPath)).toBe(afterFirst);
		writeFileSync(first.c.runtime, "corrupt\n");
		const repaired = ensureNativeArtifacts(context);
		expect(readFileSync(repaired.c.runtime, "utf-8")).toBe("!<arch>\n");
		expect(compileInvocationCount(fake.logPath)).toBe(afterFirst);

		writeFileSync(path.join(runtimeDirectory, "src/engine.c"), "int engine_value = 2;\n");
		ensureNativeArtifacts(context);
		expect(compileInvocationCount(fake.logPath)).toBe(afterFirst + 1);
		expect(events).toEqual([false, true, false, false]);

		const include = path.join(runtimeDirectory, "src/generated/entries.inc");
		mkdirSync(path.dirname(include), { recursive: true });
		writeFileSync(include, "ENTRY(first)\n");
		ensureNativeArtifacts(context);
		ensureNativeArtifacts(context);
		writeFileSync(include, "ENTRY(other)\n");
		ensureNativeArtifacts(context);
		expect(events.slice(-3)).toEqual([false, true, false]);
	});

	it("reuses runtime objects whose preprocessed inputs survive a feature flip", () => {
		const fake = createFakeToolchain();
		const runtimeDirectory = createMinimalRuntime(fake);
		const toolchain = inspectToolchain({
			rootDir: fake.root,
			rustDir: path.join(runtimeDirectory, "rust"),
			env: fake.env,
			needsCxx: false,
			platform: "linux",
		}).toolchain!;
		const cacheDirectory = path.join(fake.root, "projected-runtime-cache");
		const phases: Array<{ phase: string; durationMs: number; units?: number }> = [];
		const build = (realmsEnabled: boolean) =>
			ensureNativeArtifacts(
				resolveNativeBuildContext({
					toolchain,
					runtimeDirectory,
					cacheDirectory,
					features: {
						evalEnabled: false,
						realmsEnabled,
						webPlatformEnabled: false,
					},
					onBuildPhase: (event) => phases.push(event),
				}),
			);

		build(true);
		phases.length = 0;
		writeFileSync(fake.logPath, "");
		build(false);

		const projection = phases.find(({ phase }) => phase === "runtime C projection");
		expect(projection).toMatchObject({ units: 3 });
		expect(projection!.durationMs).toBeGreaterThanOrEqual(0);
		expect(phases).toContainEqual({
			phase: "runtime C object reuse",
			units: 3,
			durationMs: 0,
		});
		expect(phases.some(({ phase }) => phase === "runtime C object compile")).toBe(false);
		expect(compileInvocationCount(fake.logPath)).toBe(0);
	});

	it("runs Cargo when the cached Rust library is missing or corrupt", () => {
		const fake = createFakeToolchain();
		const runtimeDirectory = createMinimalRuntime(fake);
		const toolchain = inspectToolchain({
			rootDir: fake.root,
			rustDir: path.join(runtimeDirectory, "rust"),
			env: fake.env,
			needsCxx: false,
			platform: "linux",
		}).toolchain!;
		const context = resolveNativeBuildContext({
			toolchain,
			runtimeDirectory,
			cacheDirectory: path.join(fake.root, "rust-manifest-cache"),
			environment: fake.env,
			features: { evalEnabled: false, webPlatformEnabled: false },
		});
		const cargoBuildCount = (): number =>
			readFileSync(fake.logPath, "utf-8")
				.split("\n")
				.filter((line) => line.startsWith("cargo build ")).length;
		const first = ensureRustArtifacts(context);
		expect(cargoBuildCount()).toBe(1);
		rmSync(first.library);
		const repaired = ensureRustArtifacts(context);
		expect(cargoBuildCount()).toBe(2);
		writeFileSync(repaired.library, "{}");
		const rebuilt = ensureRustArtifacts(context);
		expect(cargoBuildCount()).toBe(3);
		expect(readFileSync(rebuilt.library, "utf-8")).toBe("!<arch>\n");
	});

	it("publishes concurrent runtime builds as one complete cache entry", async () => {
		const fake = createFakeToolchain();
		const runtimeDirectory = createMinimalRuntime(fake);
		const toolchain = inspectToolchain({
			rootDir: fake.root,
			rustDir: path.join(runtimeDirectory, "rust"),
			env: fake.env,
			needsCxx: false,
			platform: "linux",
		}).toolchain!;
		const code = `
			import { resolveNativeBuildContext } from "./src/native-build-context.ts";
			import { ensureNativeArtifacts } from "./src/runtime-build.ts";
			const context = resolveNativeBuildContext({
				toolchain: JSON.parse(process.env.MAL_TEST_TOOLCHAIN),
				runtimeDirectory: process.env.MAL_TEST_RUNTIME,
				cacheDirectory: process.env.MAL_TEST_CACHE,
				features: {
					evalEnabled: false,
					webPlatformEnabled: false,
				},
			});
			ensureNativeArtifacts(context);
		`;
		const cacheDirectory = path.join(fake.root, "concurrent-cache");
		const run = (): Promise<void> =>
			new Promise((resolve, reject) => {
				const child = spawn(process.execPath, ["--input-type=module", "--eval", code], {
					cwd: path.resolve("."),
					env: {
						...process.env,
						MAL_TEST_TOOLCHAIN: JSON.stringify(toolchain),
						MAL_TEST_RUNTIME: runtimeDirectory,
						MAL_TEST_CACHE: cacheDirectory,
					},
					stdio: ["ignore", "ignore", "pipe"],
				});
				let stderr = "";
				child.stderr.setEncoding("utf-8");
				child.stderr.on("data", (chunk: string) => (stderr += chunk));
				child.on("error", reject);
				child.on("exit", (status) => {
					if (status === 0) resolve();
					else reject(new Error(`concurrent build exited ${status}: ${stderr}`));
				});
			});
		await Promise.all([run(), run()]);

		const runtimeEvents: Array<boolean> = [];
		const artifacts = ensureNativeArtifacts(
			resolveNativeBuildContext({
				toolchain,
				runtimeDirectory,
				cacheDirectory,
				features: {
					evalEnabled: false,
					webPlatformEnabled: false,
				},
				onCacheEvent: (event) => {
					if (event.artifact === "runtime") runtimeEvents.push(event.hit);
				},
			}),
		);
		expect(runtimeEvents).toEqual([true]);
		expect(artifacts.c.linkArgs).toEqual([
			artifacts.c.runtime,
			artifacts.c.host,
			artifacts.c.engine,
		]);
		expect(artifacts.rust.linkArgs[0]).toBe(artifacts.rust.library);
		expect(artifacts.linkArgs).toEqual([
			...artifacts.c.linkArgs,
			...artifacts.rust.linkArgs,
		]);
		expect(
			artifacts.linkArgs
				.filter((artifact) => !artifact.startsWith("-"))
				.every((artifact) => existsSync(artifact)),
		).toBe(true);
	});

	it("reports reusable runtime cache misses and hits", () => {
		const fake = createFakeToolchain();
		const runtimeDirectory = createMinimalRuntime(fake);
		const report = inspectToolchain({
			rootDir: fake.root,
			rustDir: path.join(runtimeDirectory, "rust"),
			env: fake.env,
			needsCxx: false,
			platform: "linux",
		});
		const toolchain = report.toolchain!;
		const runtimeEvents: Array<boolean> = [];
		const context = resolveNativeBuildContext({
			toolchain,
			runtimeDirectory,
			cacheDirectory: path.join(fake.root, "event-cache"),
			features: {
				evalEnabled: false,
				webPlatformEnabled: false,
			},
			onCacheEvent: (event: {
				artifact: "runtime" | "rust" | "binary";
				hit: boolean;
			}) => {
				if (event.artifact === "runtime") runtimeEvents.push(event.hit);
			},
		});
		ensureNativeArtifacts(context);
		ensureNativeArtifacts(context);
		expect(runtimeEvents).toEqual([false, true]);
	});

	it("stores compiler wires under the reusable cache", () => {
		const bytes = new Uint8Array([0x4d, 0x41, 0x4c]);
		const wirePath = ensureCompilerWire({ kind: "bytes", bytes });
		expect(wirePath).toContain(path.join(maligatorCacheDirectory(), "compiler-wire"));
		expect(readFileSync(wirePath)).toEqual(Buffer.from(bytes));
	});

	it("reports all missing tools with platform-specific installation suggestions", () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "mal-toolchain-missing-"));
		const rustDir = path.join(root, "runtime/rust");
		mkdirSync(rustDir, { recursive: true });
		const report = inspectToolchain({
			rootDir: root,
			rustDir,
			env: { PATH: "" },
			platform: "linux",
		});

		expect(report.toolchain).toBeUndefined();
		expect(
			report.issues.filter((issue) => issue.required).map((issue) => issue.tool),
		).toEqual(expect.arrayContaining(["cc", "cxx", "ar", "rustup"]));
		expect(formatToolchainReport(report, "linux")).toContain(
			"sudo apt install build-essential",
		);
		expect(formatToolchainReport(report, "darwin")).toContain("xcode-select --install");
	});

	it("uses the exact same suggestions and readiness tail in both report modes", () => {
		const report: ToolchainReport = {
			tools: {},
			cacheHit: false,
			issues: [{ tool: "cc", message: "not found", required: true }],
		};
		const tail = [
			"",
			"Suggested fixes:",
			"  Install Apple build tools: xcode-select --install",
			"",
			"Toolchain is not ready.",
		].join("\n");

		expect(formatToolchainReport(report, "darwin")).toBe(
			`Maligator native toolchain:\n[missing] cc: not found\n${tail}`,
		);
		expect(formatToolchainReport(report, "darwin", true)).toBe(
			`Maligator native toolchain:\n[missing] cc: not found\n${tail}`,
		);
	});
});
