import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { selectNativeBuildPlan } from "../src/build-flags.ts";
import { ensureCompilerWire } from "../src/compiler-bake.ts";
import {
	buildLocalBinary,
	ensureRuntimeLibrary,
	runtimeArtifactKey,
} from "../src/local-build.ts";
import { formatToolchainReport, inspectToolchain } from "../src/toolchain.ts";

interface FakeToolchain {
	root: string;
	bin: string;
	rustDir: string;
	logPath: string;
	env: NodeJS.ProcessEnv;
}

function executable(filePath: string, body: string): void {
	writeFileSync(filePath, `#!/bin/sh\n${body}`);
	chmodSync(filePath, 0o755);
}

function compilerScript(version: string, logPath: string, lto = true): string {
	return `
printf '%s\n' "$*" >> '${logPath}'
if [ "$1" = "--version" ]; then printf '%s\n' '${version}'; exit 0; fi
if [ "$1" = "-dumpmachine" ]; then printf '%s\n' 'fake-target'; exit 0; fi
${lto ? "" : 'case " $* " in *" -flto "*) exit 1;; esac'}
out=''
while [ "$#" -gt 0 ]; do
	if [ "$1" = "-o" ]; then shift; out="$1"; fi
	shift
done
if [ -n "$out" ]; then /usr/bin/touch "$out"; /bin/chmod +x "$out"; fi
exit 0
`;
}

function createFakeToolchain(
	options: { lto?: boolean; strip?: boolean } = {},
): FakeToolchain {
	const root = mkdtempSync(path.join(os.tmpdir(), "mal-toolchain-"));
	const bin = path.join(root, "bin");
	const rustDir = path.join(root, "runtime/rust");
	const logPath = path.join(root, "cc.log");
	mkdirSync(bin);
	mkdirSync(rustDir, { recursive: true });
	writeFileSync(logPath, "");

	executable(
		path.join(bin, "fake-cc"),
		compilerScript("fake cc 1", logPath, options.lto ?? true),
	);
	executable(path.join(bin, "fake-cxx"), compilerScript("fake cxx 1", logPath));
	executable(
		path.join(bin, "ar"),
		`if [ "$1" = "--version" ]; then printf '%s\\n' "fake ar 1"; exit 0; fi
printf 'ar %s\\n' "$*" >> '${logPath}'
/usr/bin/touch "$2"
`,
	);
	executable(
		path.join(bin, "cargo"),
		'if [ "$1" = "--version" ]; then printf \'%s\\n\' "cargo 1.96.0"; fi\n',
	);
	executable(
		path.join(bin, "rustc"),
		'if [ "$1" = "--version" ]; then printf \'%s\\n\' "rustc 1.96.0"; elif [ "$1" = "-vV" ]; then printf \'%s\\n\' "rustc 1.96.0" "host: fake-rust-target"; fi\n',
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

function compileInvocationCount(logPath: string): number {
	return readFileSync(logPath, "utf-8")
		.split("\n")
		.filter((line) => line.includes(" -o ") || line.startsWith("-std=c2x")).length;
}

describe("native toolchain discovery", () => {
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
			strip: true,
			cxxLink: true,
		});
		const summary = formatToolchainReport(report, "linux");
		expect(summary).toContain("[ok] C compiler");
		expect(summary).toContain("[ok] Rust compiler");
		expect(formatToolchainReport(report, "linux", true)).toContain("fake cc 1");
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
		const suffix = `fake-${path.basename(fake.root)}`;

		ensureRuntimeLibrary(false, {
			toolchain,
			evalEnabled: false,
			webPlatformEnabled: false,
			cacheSuffix: suffix,
			rustCacheSuffix: suffix,
		});
		const binary = buildLocalBinary({
			toolchain,
			name: "fake-output",
			cSource: "int value;",
			verbose: false,
			outDir: fake.root,
			skipRuntimeBuild: true,
			evalEnabled: false,
			webPlatformEnabled: false,
			cacheSuffix: suffix,
			rustCacheSuffix: suffix,
		});

		const invocations = readFileSync(fake.logPath, "utf-8");
		expect(invocations).toContain("runtime/src/vm.c");
		expect(invocations).toContain("ar rcs");
		expect(invocations).toContain(`${binary}.c`);
		expect(invocations).toContain(`-o ${binary}`);
		expect(existsSync(`${binary}.c`)).toBe(true);
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
		const suffix = `production-${path.basename(fake.root)}`;

		ensureRuntimeLibrary(false, {
			toolchain,
			plan: production,
			evalEnabled: false,
			webPlatformEnabled: false,
			cacheSuffix: suffix,
			rustCacheSuffix: suffix,
		});
		const binary = buildLocalBinary({
			toolchain,
			plan: production,
			name: "production-output",
			cSource: "int value;",
			verbose: false,
			outDir: fake.root,
			skipRuntimeBuild: true,
			evalEnabled: false,
			webPlatformEnabled: false,
			cacheSuffix: suffix,
			rustCacheSuffix: suffix,
		});

		const invocations = readFileSync(fake.logPath, "utf-8");
		expect(invocations).toMatch(/-O2 -flto .*runtime\/src\/vm\.c/);
		expect(invocations).toContain(`-O2 -flto`);
		expect(invocations).toContain(`strip --strip-all ${binary}`);
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
		buildLocalBinary({
			toolchain,
			plan: development,
			name: "development-output",
			cSource: "int value;",
			verbose: false,
			outDir: fake.root,
			skipRuntimeBuild: true,
			evalEnabled: false,
			webPlatformEnabled: false,
			cacheSuffix: `development-${path.basename(fake.root)}`,
			rustCacheSuffix: `development-${path.basename(fake.root)}`,
		});
		const developmentInvocation = readFileSync(fake.logPath, "utf-8");
		expect(developmentInvocation).toContain("-O2");
		expect(developmentInvocation).not.toContain("-flto");
		expect(developmentInvocation).not.toContain("strip ");

		writeFileSync(fake.logPath, "");
		buildLocalBinary({
			toolchain,
			plan: production,
			name: "fallback-output",
			cSource: "int value;",
			verbose: false,
			outDir: fake.root,
			skipRuntimeBuild: true,
			evalEnabled: false,
			webPlatformEnabled: false,
			cacheSuffix: `fallback-${path.basename(fake.root)}`,
			rustCacheSuffix: `fallback-${path.basename(fake.root)}`,
		});
		const invocation = readFileSync(fake.logPath, "utf-8");
		expect(invocation).toContain("-O2");
		expect(invocation).not.toContain("-flto");
		expect(invocation).not.toContain("strip ");
	});

	it("separates runtime cache keys by source, config, toolchain, and mode", () => {
		const base = {
			cacheSuffix: "config-a",
			flags: "-O2",
			mode: "development" as const,
			sourceHash: "source-a",
			toolchainFingerprint: "toolchain-a",
			target: "target-a",
		};
		const key = runtimeArtifactKey(base);
		expect(runtimeArtifactKey({ ...base, sourceHash: "source-b" })).not.toBe(key);
		expect(runtimeArtifactKey({ ...base, cacheSuffix: "config-b" })).not.toBe(key);
		expect(runtimeArtifactKey({ ...base, toolchainFingerprint: "toolchain-b" })).not.toBe(
			key,
		);
		expect(runtimeArtifactKey({ ...base, mode: "production" })).not.toBe(key);
	});

	it("reports reusable runtime cache misses and hits", () => {
		const fake = createFakeToolchain();
		const report = inspectToolchain({
			rootDir: fake.root,
			rustDir: fake.rustDir,
			env: fake.env,
			needsCxx: false,
			platform: "linux",
		});
		const toolchain = report.toolchain!;
		const suffix = `cache-events-${path.basename(fake.root)}`;
		const runtimeEvents: Array<boolean> = [];
		const dimensions = {
			toolchain,
			evalEnabled: false,
			webPlatformEnabled: false,
			cacheSuffix: suffix,
			rustCacheSuffix: suffix,
			onCacheEvent: (event: { artifact: "runtime" | "rust"; hit: boolean }) => {
				if (event.artifact === "runtime") runtimeEvents.push(event.hit);
			},
		};
		ensureRuntimeLibrary(false, dimensions);
		ensureRuntimeLibrary(false, dimensions);
		expect(runtimeEvents).toEqual([false, true]);
	});

	it("stores compiler wires under the reusable cache", () => {
		const bytes = new Uint8Array([0x4d, 0x41, 0x4c]);
		const wirePath = ensureCompilerWire({ bytes });
		expect(wirePath).toContain(
			`${path.sep}.cache${path.sep}mal-cache${path.sep}compiler-wire`,
		);
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
});
