import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { BUILD_CONFIG_NAME, detectInitialEntry, initProject } from "../src/cli-init.ts";
import { executeBinary } from "../src/cli-run.ts";
import { CLI_HELP, CliUsageError, MALIGATOR_VERSION, parseCliArgs } from "../src/cli.ts";

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
		]);
		expect(command).toMatchObject({
			kind: "build",
			entry: "src/main.ts",
			configPath: "other.json",
			production: true,
		});
	});

	it("preserves run arguments after the separator verbatim", () => {
		expect(
			parseCliArgs(["run", "src/main.ts", "--", "--flag", "two words", "-x"]),
		).toEqual({
			kind: "run",
			entry: "src/main.ts",
			programArgs: ["--flag", "two words", "-x"],
		});
	});

	it("parses verbose doctor output", () => {
		expect(parseCliArgs(["doctor"])).toEqual({ kind: "doctor", verbose: false });
		expect(parseCliArgs(["doctor", "--verbose"])).toEqual({
			kind: "doctor",
			verbose: true,
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
	])("rejects malformed arguments %#", (args, message) => {
		expect(() => parseCliArgs(args)).toThrow(CliUsageError);
		expect(() => parseCliArgs(args)).toThrow(message);
	});
});

describe("command shell", () => {
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
		expect(result.stdout).toContain("run 'maligator init'");
	});

	it("returns nonzero and actionable diagnostics when doctor cannot find tools", () => {
		const result = invokeCli(["doctor"], repoRoot, { ...process.env, PATH: "" });
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("[missing] cmake");
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
			`import { defineBuild } from "maligator";\n\nexport default defineBuild({\n\tentry: "src/index.ts",\n});\n`,
		);
	});

	it("refuses to overwrite an existing config", () => {
		const dir = tmpdir();
		initProject(dir);
		const result = invokeCli(["init"], dir);
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("build config already exists");
	});
});
