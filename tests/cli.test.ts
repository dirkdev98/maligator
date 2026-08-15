import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	applicationDriverPath,
	devCommand,
	developmentCompilerInstallation,
	productCompilerInstallation,
} from "../src/cli-commands.ts";
import { BUILD_CONFIG_NAME, detectInitialEntry, initProject } from "../src/cli-init.ts";
import { executeBinary } from "../src/cli-run.ts";
import { CLI_HELP, CliUsageError, MALIGATOR_VERSION, parseCliArgs } from "../src/cli.ts";
import {
	PRODUCT_RUNTIME_ASSET_INCLUDE,
	productCliConfig,
} from "../src/product-builder.ts";
import { stripTypesWithTypeScript } from "../src/typescript-strip.ts";

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
			production: true,
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
	});

	it("accepts the internal build diagnostics through the strict parser", () => {
		const command = parseCliArgs([
			"build",
			"fixture.js",
			"--serialize",
			"fixture.malw",
			"--no-compiled",
			"--dump-escape",
		]);
		expect(command).toMatchObject({
			kind: "build",
			internal: {
				serializePath: "fixture.malw",
				compiled: false,
				dumpEscape: true,
			},
		});
	});

	it.each([
		[[], "missing command"],
		[["compile"], "unknown command 'compile'"],
		[["build", "--wat"], "unknown option '--wat'"],
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
			testNodeGlobalsPath: path.join(repoRoot, "src/testing/node-globals.mjs"),
			frontendIdentity: "typescript-strip-v1",
			evalCompiler: {
				kind: "source",
				sourceDirectory: path.join(repoRoot, "src"),
				entrypoint: path.join(repoRoot, "src/eval-compiler-entry.mts"),
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
		);
		expect(installation.runtimeDirectory).toBe(path.resolve("relative-runtime"));
		expect(installation.testModulePath).toBe(path.resolve("test-runtime.mjs"));
		expect(installation.testNodeGlobalsPath).toBe(path.resolve("node-globals.mjs"));
		expect(installation.frontendIdentity).toBe("compact-type-strip-v1");
		expect(installation.evalCompiler).toEqual({
			kind: "prebuilt",
			wirePath: path.resolve("compiler.malw"),
		});
		expect(installation.developmentRunner).toEqual({
			executablePath: path.resolve("bin/maligator"),
			externalAssets: true,
			webPlatform: true,
			node: true,
			realms: true,
			intl: false,
			scheduler: "single",
		});
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
		expect(productConfig.assets.testNodeGlobals).toEqual({
			type: "file",
			path: path.join(repoRoot, "src/testing/node-globals.mjs"),
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
		expect(result.stderr).toContain("Compiler phase · compile to ir:");
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
});

describe("development coordinator", () => {
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
				stripTypes: stripTypesWithTypeScript,
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
				stripTypes: stripTypesWithTypeScript,
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
