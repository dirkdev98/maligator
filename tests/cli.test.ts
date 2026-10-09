import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as cacheManagement from "../src/cache-management.ts";
import {
	applicationDriverPath,
	devCommand,
	developmentCompilerInstallation,
	productCompilerInstallation,
	runCli,
	runCommand,
} from "../src/cli-commands.ts";
import type { BuildCommandResult } from "../src/cli-commands.ts";
import { BUILD_CONFIG_NAME, detectInitialEntry, initProject } from "../src/cli-init.ts";
import { executeBinary, executeBinaryCaptured } from "../src/cli-run.ts";
import { CLI_HELP, CliUsageError, MALIGATOR_VERSION, parseCliArgs } from "../src/cli.ts";
import type { CompilationOptions } from "../src/compiler-service.ts";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { FrontendCompilationSession } from "../src/frontend-cache.ts";
import {
	PRODUCT_RUNTIME_ASSET_INCLUDE,
	productCliConfig,
} from "../src/product-builder.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cliEntry = path.join(repoRoot, "src/index.ts");

function invokeCli(
	args: Array<string>,
	cwd = repoRoot,
	env: NodeJS.ProcessEnv = process.env,
) {
	return spawnSync(process.execPath, [cliEntry, ...args], {
		cwd,
		env,
		encoding: "utf-8",
	});
}

function tmpdir(): string {
	return mkdtempSync(path.join(os.tmpdir(), "mal-cli-"));
}

describe("parseCliArgs", () => {
	it("streams dev status and requires explicit test isolation for parallel execution", () => {
		expect(parseCliArgs(["dev", "--status"])).toMatchObject({
			kind: "dev",
			status: true,
		});
		expect(
			parseCliArgs([
				"test",
				"--concurrency",
				"3",
				"--isolate",
				"--compile-concurrency",
				"2",
			]),
		).toMatchObject({
			isolation: "file",
			executionConcurrency: 3,
			compileConcurrency: 2,
		});
		expect(() => parseCliArgs(["run", "--status"])).toThrow("unknown option");
		expect(() => parseCliArgs(["test", "--concurrency", "2"])).toThrow(
			"requires --isolate",
		);
		expect(() => parseCliArgs(["test", "--isolate", "--profile"])).toThrow(
			"cannot be combined",
		);
		expect(parseCliArgs(["test", "--watch", "--watch-failed", "--status"])).toMatchObject(
			{ watch: true, watchFailed: true, status: true },
		);
		expect(() => parseCliArgs(["test", "--watch", "--profile"])).toThrow(
			"cannot be combined",
		);
		expect(() => parseCliArgs(["test", "--watch-failed"])).toThrow("requires --watch");
		expect(() => parseCliArgs(["test", "--status"])).toThrow("requires --watch");
	});
	it("parses build options around an optional entry", () => {
		const command = parseCliArgs([
			"build",
			"--config",
			"other.json",
			"src/main.ts",
			"--production",
			"--target",
			"x86_64-unknown-linux-gnu",
			"--artifact",
			"dist/release",
		]);
		expect(command).toMatchObject({
			kind: "build",
			entry: "src/main.ts",
			configPath: "other.json",
			production: true,
			target: "x86_64-unknown-linux-gnu",
			artifactDirectory: "dist/release",
		});
	});

	it("preserves run arguments after the separator verbatim", () => {
		expect(
			parseCliArgs(["run", "src/main.ts", "--", "--flag", "two words", "-x"]),
		).toEqual({
			kind: "run",
			entry: "src/main.ts",
			verbose: false,
			profile: false,
			programArgs: ["--flag", "two words", "-x"],
		});
		expect(parseCliArgs(["run", "src/main.ts", "--verbose"])).toMatchObject({
			kind: "run",
			verbose: true,
		});
	});

	it("parses the retained development loop with run-compatible arguments", () => {
		expect(
			parseCliArgs(["dev", "src/main.ts", "--verbose", "--", "--flag", "two words"]),
		).toEqual({
			kind: "dev",
			entry: "src/main.ts",
			verbose: true,
			profile: false,
			programArgs: ["--flag", "two words"],
		});
	});

	it("parses first-class test selection and execution controls", () => {
		expect(
			parseCliArgs([
				"test",
				"src/router",
				"src/cache.test.ts",
				"--run",
				"router > parameters",
				"--shuffle",
				"18492",
				"--repeat",
				"10",
				"--bail",
			]),
		).toEqual({
			kind: "test",
			paths: ["src/router", "src/cache.test.ts"],
			nameFilter: "router > parameters",
			shuffle: 18492,
			repeat: 10,
			bail: true,
			timeoutMs: 5000,
			compileConcurrency: 1,
			profile: false,
		});
		expect(parseCliArgs(["test", "--shuffle"])).toMatchObject({
			kind: "test",
			shuffle: true,
		});
	});

	it("parses one profile flag consistently across existing commands", () => {
		expect(parseCliArgs(["build", "src/main.ts", "--profile"])).toMatchObject({
			kind: "build",
			production: false,
			profile: true,
		});
		expect(parseCliArgs(["run", "src/main.ts", "--profile"])).toMatchObject({
			kind: "run",
			profile: true,
		});
		expect(parseCliArgs(["dev", "src/main.ts", "--profile"])).toMatchObject({
			kind: "dev",
			profile: true,
		});
		expect(parseCliArgs(["test", "src", "--profile"])).toMatchObject({
			kind: "test",
			profile: true,
		});
	});

	it("keeps exact compiler counters behind an explicit profile mode", () => {
		for (const command of ["build", "run", "dev", "test"]) {
			expect(parseCliArgs([command, "src/main.ts", "--profile=compiler"])).toMatchObject({
				kind: command,
				profile: true,
				profileCompiler: true,
			});
		}
		expect(() => parseCliArgs(["run", "src/main.ts", "--profile=unknown"])).toThrow(
			CliUsageError,
		);
	});

	it("parses verbose doctor output", () => {
		expect(parseCliArgs(["doctor"])).toEqual({ kind: "doctor", verbose: false });
		expect(parseCliArgs(["doctor", "--verbose"])).toEqual({
			kind: "doctor",
			verbose: true,
		});
		expect(
			parseCliArgs(["doctor", "--target", "aarch64-unknown-linux-gnu", "--verbose"]),
		).toEqual({
			kind: "doctor",
			target: "aarch64-unknown-linux-gnu",
			verbose: true,
		});
	});

	it("parses cache status and conservative prune controls", () => {
		expect(parseCliArgs(["cache", "status"])).toEqual({
			kind: "cache",
			action: "status",
			dryRun: false,
			verbose: false,
		});
		expect(
			parseCliArgs([
				"cache",
				"prune",
				"--dry-run",
				"--verbose",
				"--max-gb",
				"2.5",
				"--min-age-days",
				"3",
			]),
		).toEqual({
			kind: "cache",
			action: "prune",
			dryRun: true,
			verbose: true,
			maxBytes: 2.5 * 1024 ** 3,
			minAgeMs: 3 * 24 * 60 * 60 * 1000,
		});
		expect(parseCliArgs(["cache", "clear", "--all"])).toEqual({
			kind: "cache",
			action: "clear",
			dryRun: false,
			verbose: false,
		});
		expect(() => parseCliArgs(["cache", "clear"])).toThrow(
			"cache clear requires '--all'",
		);
	});

	it("accepts the internal build diagnostics through the strict parser", () => {
		const command = parseCliArgs([
			"build",
			"fixture.js",
			"--serialize",
			"fixture.malw",
			"--no-compiled",
			"--dump-core",
		]);
		expect(command).toMatchObject({
			kind: "build",
			internal: {
				serializePath: "fixture.malw",
				compiled: false,
				dumpCore: true,
			},
		});
	});

	it.each([
		[[], "missing command"],
		[["compile"], "unknown command 'compile'"],
		[["build", "--wat"], "unknown option '--wat'"],
		[["build", "--ablate-optimization"], "unknown option '--ablate-optimization'"],
		[["build", "--core-cache"], "unknown option '--core-cache'"],
		[["build", "--config"], "option '--config' requires a value"],
		[["build", "one.ts", "two.ts"], "unexpected argument 'two.ts'"],
		[["run", "one.ts", "two.ts"], "unexpected argument 'two.ts'"],
		[["test", "--repeat", "0"], "requires a positive integer"],
	])("rejects malformed arguments %#", (args, message) => {
		expect(() => parseCliArgs(args)).toThrow(CliUsageError);
		expect(() => parseCliArgs(args)).toThrow(message);
	});
});

describe("command shell", () => {
	it("resolves development compiler resources from the CLI module", () => {
		const installation = developmentCompilerInstallation(path.join(repoRoot, "src"));
		expect(installation).toEqual({
			runtimeDirectory: path.join(repoRoot, "runtime"),
			licensePath: path.join(repoRoot, "LICENSE"),
			testModulePath: path.join(repoRoot, "src/testing/runtime.mjs"),
			nodeGlobalsPath: path.join(repoRoot, "src/node-globals.mjs"),
			platformSourceRoot: path.join(repoRoot, "src"),
			frontendIdentity: "compact-type-strip-v3",
			evalCompiler: {
				kind: "source",
				sourceDirectory: path.join(repoRoot, "src"),
				entrypoint: path.join(repoRoot, "src/compiler/pipeline/eval-compiler-entry.mts"),
			},
		});
		expect(path.isAbsolute(installation.runtimeDirectory)).toBe(true);
	});

	it("normalizes materialized product compiler resources to absolute paths", () => {
		const installation = productCompilerInstallation(
			"relative-runtime",
			"compiler.malw",
			"test-runtime.mjs",
			undefined,
			"bin/maligator",
			undefined,
			"bin/maligator-mutable",
		);
		expect(installation.runtimeDirectory).toBe(path.resolve("relative-runtime"));
		expect(installation.testModulePath).toBe(path.resolve("test-runtime.mjs"));
		expect(installation.nodeGlobalsPath).toBe(path.resolve("node-globals.mjs"));
		// One stripper means the development and product front ends share cache entries.
		expect(installation.frontendIdentity).toBe(
			developmentCompilerInstallation(path.join(repoRoot, "src")).frontendIdentity,
		);
		expect(installation.frontendIdentity).toBe("compact-type-strip-v3");
		expect(installation.evalCompiler).toEqual({
			kind: "prebuilt",
			wirePath: path.resolve("compiler.malw"),
		});
		expect(installation.developmentRunners).toEqual([
			{
				executablePath: path.resolve("bin/maligator"),
				inProcess: true,
				wireProtocol: "product",
				externalAssets: true,
				primordials: "locked",
				webPlatform: true,
				node: true,
				eval: true,
				realms: true,
				regexp: true,
				temporal: false,
				intl: false,
			},
			{
				executablePath: path.resolve("bin/maligator-mutable"),
				inProcess: false,
				wireProtocol: "wire-list",
				externalAssets: true,
				primordials: "mutable",
				webPlatform: true,
				node: true,
				eval: true,
				realms: true,
				regexp: true,
				temporal: false,
				intl: false,
			},
		]);
	});

	it("selects the event-loop driver for web or Node surfaces", () => {
		const installation = developmentCompilerInstallation(path.join(repoRoot, "src"));
		expect(applicationDriverPath(installation, true)).toBe(
			path.join(repoRoot, "runtime/host_main.c"),
		);
		expect(applicationDriverPath(installation, false, true)).toBe(
			path.join(repoRoot, "runtime/host_main.c"),
		);
		expect(applicationDriverPath(installation, false)).toBe(
			path.join(repoRoot, "runtime/test262_main.c"),
		);
		expect(PRODUCT_RUNTIME_ASSET_INCLUDE).toContain("host_main.c");
		expect(PRODUCT_RUNTIME_ASSET_INCLUDE).toContain("dev_main.c");
		expect(PRODUCT_RUNTIME_ASSET_INCLUDE).toContain("test262_main.c");
		expect(PRODUCT_RUNTIME_ASSET_INCLUDE).toContain("vendor/llhttp/include/**");
		expect(PRODUCT_RUNTIME_ASSET_INCLUDE).toContain("vendor/llhttp/src/**");
		expect(PRODUCT_RUNTIME_ASSET_INCLUDE).toContain("vendor/sqlite/**");
		const productConfig = productCliConfig(
			repoRoot,
			path.join(repoRoot, "compiler.malw"),
			path.join(repoRoot, "compiler-producers.json"),
			path.join(repoRoot, "maligator-mutable"),
		);
		expect(productConfig.engine.realms).toBe(true);
		expect(productConfig.surface.webPlatform).toBe(true);
		expect(productConfig.surface.node).toBe(true);
		expect(productConfig.assets.runtime).toMatchObject({
			path: path.join(repoRoot, "runtime"),
			include: PRODUCT_RUNTIME_ASSET_INCLUDE,
		});
		expect(productConfig.assets.license).toEqual({
			type: "file",
			path: path.join(repoRoot, "LICENSE"),
		});
		expect(productConfig.assets.testRuntime).toEqual({
			type: "file",
			path: path.join(repoRoot, "src/testing/runtime.mjs"),
		});
		expect(productConfig.assets.compilerProducerDigests).toEqual({
			type: "file",
			path: path.join(repoRoot, "compiler-producers.json"),
		});
		expect(productConfig.assets.mutableDevelopmentRunner).toEqual({
			type: "file",
			path: path.join(repoRoot, "maligator-mutable"),
		});
		expect(productConfig.assets.nodeGlobals).toEqual({
			type: "file",
			path: path.join(repoRoot, "src/node-globals.mjs"),
		});
	});

	it("prints help without entering the compiler", () => {
		const result = invokeCli(["--help"]);
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe(CLI_HELP);
		expect(result.stderr).toBe("");
	});

	it("prints the version without entering the compiler", () => {
		const result = invokeCli(["--version"]);
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe(MALIGATOR_VERSION);
	});

	it("reports usage errors on stderr with status 2", () => {
		const result = invokeCli(["build", "--unknown"]);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("error: unknown option '--unknown' for 'build'");
		expect(result.stderr).toContain("maligator --help");
	});

	it("suggests init when build has no explicit or configured entry", () => {
		const result = invokeCli(["build"]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("run 'maligator init'");
	});

	it("skips disabled-feature policy for portable serialization", () => {
		const dir = tmpdir();
		const entry = path.join(dir, "entry.js");
		const config = path.join(dir, "maligator.build.ts");
		const output = path.join(dir, "entry.malw");
		writeFileSync(entry, 'eval("1 + 1"); /a/.test("a");');
		writeFileSync(config, "export default { engine: { eval: false, regexp: false } };\n");

		const result = invokeCli(["build", entry, "--config", config, "--serialize", output]);

		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(result.stdout.trim()).toBe(output);
		expect(result.stderr).toContain("Compile modules");
		expect(result.stderr).toContain("Serialized");
		expect(readFileSync(output).length).toBeGreaterThan(0);
	});

	it("keeps verbose build diagnostics on stderr", () => {
		const dir = tmpdir();
		const entry = path.join(dir, "entry.ts");
		const output = path.join(dir, "entry.malw");
		writeFileSync(entry, "const answer: number = 42; console.log(answer);");

		const result = invokeCli(["build", entry, "--serialize", output, "--verbose"]);

		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(result.stdout).toBe(`${output}\n`);
		expect(result.stderr).toContain("Compile modules completed");
		expect(result.stderr).toContain("Entrypoint:");
		expect(result.stderr).toContain("Frontend phases:");
		expect(result.stderr).toContain("File digests:");
		expect(result.stderr).toContain("Dependencies: 1");
		expect(result.stderr).toContain("Compiler phase · construct core ir:");
		expect(result.stderr).toContain("Core optimizer input:");
		expect(result.stderr).toContain("Core optimizer queue:");
	}, 30_000);

	it("rejects a configured cache root that is a file instead of reporting an empty cache", () => {
		const configured = path.join(tmpdir(), "cache-file");
		writeFileSync(configured, "not a directory\n");

		const result = invokeCli(["cache", "status"], repoRoot, {
			...process.env,
			MALIGATOR_CACHE_DIR: configured,
		});

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("MALIGATOR_CACHE_DIR");
		expect(result.stderr).toContain(configured);
		expect(result.stderr).toContain("is a file, not a directory");
		expect(result.stderr).toContain("writable directory");
		expect(result.stdout).not.toContain("Total:");
		expect(result.stdout).not.toContain("managed");
	});

	it("returns nonzero and actionable diagnostics when doctor cannot find tools", () => {
		const result = invokeCli(["doctor"], repoRoot, { ...process.env, PATH: "" });
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("[missing] cc");
		expect(result.stdout).toContain("Install Rustup");
		if (process.platform === "darwin") {
			expect(result.stdout).toContain("xcode-select --install");
		} else if (process.platform === "linux") {
			expect(result.stdout).toContain("apt install build-essential");
		}
	});
});

describe("executeBinary", () => {
	it("forwards argument boundaries to the child", () => {
		const script =
			`if (process.argv[1] !== "two words" || process.argv[2] !== "--flag") ` +
			`process.exit(9);`;
		const outcome = executeBinary(
			process.execPath,
			["-e", script, "two words", "--flag"],
			process.env,
			"ignore",
		);
		expect(outcome).toEqual({ status: 0 });
	});

	it("returns the child's non-zero status", () => {
		const outcome = executeBinary(
			process.execPath,
			["-e", "process.exit(23)"],
			process.env,
			"ignore",
		);
		expect(outcome).toEqual({ status: 23, signal: undefined });
	});

	it("returns the signal that terminated the child", () => {
		const outcome = executeBinary(
			process.execPath,
			["-e", `process.kill(process.pid, "SIGTERM")`],
			process.env,
			"ignore",
		);
		expect(outcome).toEqual({ status: undefined, signal: "SIGTERM" });
	});

	it("captures output and preserves a non-zero status", () => {
		const outcome = executeBinaryCaptured(
			process.execPath,
			[
				"-e",
				`process.stdout.write("out"); process.stderr.write("err"); process.exit(23);`,
			],
			process.env,
		);
		expect(outcome).toEqual({
			status: 23,
			signal: undefined,
			stdout: "out",
			stderr: "err",
		});
	});
});

describe("development coordinator", () => {
	it("rejects a changed newly imported dependency before replacing the application", async () => {
		const directory = tmpdir();
		const entry = path.join(directory, "entry.mts");
		const leaf = path.join(directory, "leaf.mts");
		writeFileSync(entry, 'import "./leaf.mts";\n');
		writeFileSync(leaf, "export const value = 1;\n");
		const original = new FrontendCompilationSession().snapshot(leaf);
		let finishFirst!: (result: BuildCommandResult) => void;
		let beginFirst!: () => void;
		const firstStarted = new Promise<void>((resolve) => {
			beginFirst = resolve;
		});
		let wakeWatcher!: () => void;
		const preparedOptions: Array<CompilationOptions> = [];
		const spawned: Array<string> = [];
		const watched: Array<Array<string>> = [];
		let running = false;
		const dev = devCommand(
			{ kind: "dev", entry, verbose: false, profile: false, programArgs: [] },
			{
				stripTypes: stripCompactTypes,
				installation: productCompilerInstallation(
					directory,
					"compiler.malw",
					"test-runtime.mjs",
				),
				compiler: {
					async prepare(_command, options = {}) {
						preparedOptions.push(options);
						if (preparedOptions.length === 1) {
							beginFirst();
							return new Promise<BuildCommandResult>((resolve) => {
								finishFirst = resolve;
							});
						}
						return {
							binaryPath: "current",
							dependencies: [entry, leaf],
							dependencyIdentities: [new FrontendCompilationSession().snapshot(leaf)],
						};
					},
					async close() {},
				},
				developmentWatcher: {
					create(files) {
						watched.push(files);
						return {};
					},
					update(_handle, files) {
						watched.push(files);
						wakeWatcher();
					},
					wait() {
						return new Promise<void>((resolve) => {
							wakeWatcher = resolve;
						});
					},
					close() {},
				},
				developmentProcesses: {
					spawn(binaryPath) {
						spawned.push(binaryPath);
						running = true;
						process.emit("SIGINT");
						wakeWatcher();
						return {};
					},
					kill() {
						running = false;
					},
					status() {
						return running ? undefined : 0;
					},
				},
			},
		);
		try {
			await firstStarted;
			expect(watched[0]).not.toContain(leaf);
			writeFileSync(leaf, "export const value = 2;\n");
			utimesSync(leaf, new Date(original.mtimeMs), new Date(original.mtimeMs));
			finishFirst({
				binaryPath: "stale",
				dependencies: [entry, leaf],
				dependencyIdentities: [original],
			});
			await dev;
			expect(spawned).toEqual(["current"]);
			expect(preparedOptions[1]?.invalidatedPaths).toEqual([leaf]);
			expect(watched.some((files) => files.includes(leaf))).toBe(true);
			expect(running).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("waits for asynchronous run preparation before executing the result", async () => {
		const directory = tmpdir();
		const marker = path.join(directory, "executed");
		let prepared!: (result: BuildCommandResult) => void;
		const preparation = new Promise<BuildCommandResult>((resolve) => {
			prepared = resolve;
		});
		const running = runCommand(
			{ kind: "run", verbose: false, profile: false, programArgs: [] },
			{
				stripTypes: stripCompactTypes,
				installation: productCompilerInstallation(
					directory,
					"compiler.malw",
					"test-runtime.mjs",
				),
				compiler: { prepare: () => preparation, async close() {} },
			},
		);
		try {
			expect(existsSync(marker)).toBe(false);
			prepared({
				binaryPath: process.execPath,
				runArguments: [
					"-e",
					`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "done")`,
				],
			});
			expect(await running).toEqual({ status: 0, signal: undefined });
			expect(readFileSync(marker, "utf8")).toBe("done");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("drains the compiler before releasing its cache lease or exiting after preparation failure", async () => {
		let finishClosing!: () => void;
		let startClosing!: () => void;
		const closing = new Promise<void>((resolve) => {
			finishClosing = resolve;
		});
		const closeStarted = new Promise<void>((resolve) => {
			startClosing = resolve;
		});
		const release = vi.fn();
		const lease = vi
			.spyOn(cacheManagement, "createCacheLease")
			.mockReturnValue({ release });
		const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			const running = runCli(["run", "app.mts"], {
				stripTypes: stripCompactTypes,
				installation: productCompilerInstallation(
					"/runtime",
					"/compiler.malw",
					"/test-runtime.mjs",
				),
				compiler: {
					prepare() {
						return Promise.reject(new Error("preparation failed"));
					},
					async close() {
						startClosing();
						await closing;
					},
				},
			});
			await closeStarted;
			expect(release).not.toHaveBeenCalled();
			expect(exit).not.toHaveBeenCalled();
			finishClosing();
			await running;
			expect(release).toHaveBeenCalledOnce();
			expect(exit).toHaveBeenCalledWith(1);
		} finally {
			lease.mockRestore();
			exit.mockRestore();
			stderr.mockRestore();
		}
	});

	it("observes an edit during an unresolved initial prepare and launches only the newest result", async () => {
		const directory = tmpdir();
		const entry = path.join(directory, "entry.mts");
		writeFileSync(entry, "console.log(1);\n");
		let finishFirst!: (result: BuildCommandResult) => void;
		let beginFirst!: (options: CompilationOptions) => void;
		const firstStarted = new Promise<CompilationOptions>((resolve) => {
			beginFirst = resolve;
		});
		let noticeEdit!: () => void;
		const edited = new Promise<void>((resolve) => {
			noticeEdit = resolve;
		});
		let wakeWatcher!: () => void;
		const preparedOptions: Array<CompilationOptions> = [];
		const spawned: Array<string> = [];
		let running = false;
		let watcherClosed = false;
		const dev = devCommand(
			{ kind: "dev", entry, verbose: false, profile: false, programArgs: [] },
			{
				stripTypes: stripCompactTypes,
				installation: productCompilerInstallation(
					directory,
					"compiler.malw",
					"test-runtime.mjs",
				),
				compiler: {
					async prepare(_command, options = {}) {
						preparedOptions.push(options);
						if (preparedOptions.length === 1) {
							options.signal?.addEventListener("abort", noticeEdit, { once: true });
							beginFirst(options);
							return new Promise<BuildCommandResult>((resolve) => {
								finishFirst = resolve;
							});
						}
						return { binaryPath: "newest", dependencies: [entry] };
					},
					async close() {},
				},
				developmentWatcher: {
					create() {
						return {};
					},
					update() {},
					wait() {
						return new Promise<void>((resolve) => {
							wakeWatcher = resolve;
						});
					},
					close() {
						watcherClosed = true;
					},
				},
				developmentProcesses: {
					spawn(binaryPath) {
						spawned.push(binaryPath);
						running = true;
						process.emit("SIGINT");
						wakeWatcher();
						return {};
					},
					kill() {
						running = false;
					},
					status() {
						return running ? undefined : 0;
					},
				},
			},
		);
		try {
			const first = await firstStarted;
			writeFileSync(entry, "console.log(222);\n");
			wakeWatcher();
			await edited;
			expect(first.signal?.aborted).toBe(true);
			finishFirst({ binaryPath: "stale", dependencies: [entry] });
			await dev;
			expect(spawned).toEqual(["newest"]);
			expect(preparedOptions).toHaveLength(2);
			expect(preparedOptions[1]?.invalidatedPaths).toEqual([entry]);
			expect(watcherClosed).toBe(true);
			expect(running).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("invalidates an edited file and restarts a fresh application process", async () => {
		const directory = tmpdir();
		const entry = path.join(directory, "entry.ts");
		writeFileSync(entry, "console.log(1);\n");
		let spawns = 0;
		const handles: Array<{ running: boolean }> = [];
		const processHost = {
			spawn() {
				const handle = { running: true };
				handles.push(handle);
				spawns++;
				if (spawns === 1) {
					setTimeout(() => writeFileSync(entry, "console.log(2);\n"), 25);
				} else {
					setTimeout(() => process.emit("SIGINT"), 25);
				}
				return handle;
			},
			kill(handle: unknown) {
				(handle as { running: boolean }).running = false;
			},
			status(handle: unknown) {
				return (handle as { running: boolean }).running ? undefined : 0;
			},
		};
		const installation = productCompilerInstallation(
			directory,
			path.join(directory, "compiler.malw"),
			path.join(directory, "test-runtime.mjs"),
			undefined,
			process.execPath,
		);

		await devCommand(
			{ kind: "dev", entry, verbose: false, profile: false, programArgs: [] },
			{
				stripTypes: stripCompactTypes,
				installation,
				developmentProcesses: processHost,
			},
		);

		expect(spawns).toBe(2);
		expect(handles.every((handle) => !handle.running)).toBe(true);
	});

	it("keeps the last successful application running across a failed rebuild", async () => {
		const directory = tmpdir();
		const entry = path.join(directory, "transactional-entry.ts");
		writeFileSync(entry, "console.log(1);\n");
		let spawns = 0;
		let stoppedWhileInvalid = false;
		const handles: Array<{ running: boolean }> = [];
		const processHost = {
			spawn() {
				const handle = { running: true };
				handles.push(handle);
				spawns++;
				if (spawns === 1) {
					setTimeout(() => writeFileSync(entry, "const = ;\n"), 25);
					setTimeout(() => writeFileSync(entry, "console.log(3);\n"), 180);
				} else {
					setTimeout(() => process.emit("SIGINT"), 25);
				}
				return handle;
			},
			kill(handle: unknown) {
				if (readFileSync(entry, "utf-8").includes("const =")) {
					stoppedWhileInvalid = true;
				}
				(handle as { running: boolean }).running = false;
			},
			status(handle: unknown) {
				return (handle as { running: boolean }).running ? undefined : 0;
			},
		};
		const installation = productCompilerInstallation(
			directory,
			path.join(directory, "compiler.malw"),
			path.join(directory, "test-runtime.mjs"),
			undefined,
			process.execPath,
		);

		await devCommand(
			{ kind: "dev", entry, verbose: false, profile: false, programArgs: [] },
			{
				stripTypes: stripCompactTypes,
				installation,
				developmentProcesses: processHost,
			},
		);

		expect(spawns).toBe(2);
		expect(stoppedWhileInvalid).toBe(false);
		expect(handles.every((handle) => !handle.running)).toBe(true);
	});
});

describe("maligator init", () => {
	it("selects the first existing conventional entry", () => {
		const dir = tmpdir();
		mkdirSync(path.join(dir, "src"));
		writeFileSync(path.join(dir, "src/main.ts"), "");
		writeFileSync(path.join(dir, "index.ts"), "");
		expect(detectInitialEntry(dir)).toBe("src/main.ts");
	});

	it("creates an executable build config from the command", () => {
		const dir = tmpdir();
		const result = invokeCli(["init"], dir);
		expect(result.status).toBe(0);
		const configPath = path.join(dir, BUILD_CONFIG_NAME);
		expect(result.stdout).toContain(configPath);
		expect(readFileSync(configPath, "utf-8")).toBe(
			`import { defineBuild } from "@maligator/cli";\n\nexport default defineBuild({\n\tentry: "src/index.ts",\n});\n`,
		);
	});

	it("refuses to overwrite an existing config", () => {
		const dir = tmpdir();
		initProject(dir);
		const result = invokeCli(["init"], dir);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("build config already exists");
	});
});
