import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { executeBinary } from "../src/cli-run.ts";
import { CLI_HELP, CliUsageError, MALIGATOR_VERSION, parseCliArgs } from "../src/cli.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");

function invokeCli(args: Array<string>) {
	return spawnSync(process.execPath, ["src/index.ts", ...args], {
		cwd: repoRoot,
		encoding: "utf-8",
	});
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
