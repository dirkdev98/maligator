import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanTestEnvironment } from "../scripts/test-environment.ts";
import { runEnv } from "../src/build-flags.ts";
import { executeBinary, executeBinaryReported } from "../src/cli-run.ts";

const cliEntry = resolve("src/index.ts");
const coldRunnerTimeoutMs = 300_000;
const commandTimeoutMs = 30_000;

function invokeCli(cwd: string, args: ReadonlyArray<string>, timeout = commandTimeoutMs) {
	return spawnSync(process.execPath, [cliEntry, ...args], {
		cwd,
		env: cleanTestEnvironment(),
		encoding: "utf8",
		timeout,
	});
}

describe("maligator run", () => {
	let directory: string;
	let init: ReturnType<typeof invokeCli>;
	let starter: ReturnType<typeof invokeCli>;
	beforeAll(
		() => {
			directory = mkdtempSync(join(tmpdir(), "mal-cli-run-"));
			init = invokeCli(directory, ["init"]);
			expect(init.error, init.stderr).toBeUndefined();
			expect(init.status, init.stderr).toBe(0);
			// Both cases share the starter's native runner even if Vitest shuffles them.
			starter = invokeCli(directory, ["run"], coldRunnerTimeoutMs);
			expect(starter.error, starter.stderr).toBeUndefined();
			expect(starter.status, starter.stderr).toBe(0);
		},
		commandTimeoutMs + coldRunnerTimeoutMs + 5000,
	);
	afterAll(() => {
		if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
	});

	it("initializes an empty project that runs with only application output", () => {
		expect(init.stdout).toContain("maligator run src/index.ts");
		expect(init.stdout).toContain("maligator dev");
		expect(init.stdout).toContain("maligator test");
		expect(
			JSON.parse(readFileSync(join(directory, "package.json"), "utf8")),
		).toMatchObject({
			type: "module",
		});
		const tsconfig = JSON.parse(
			readFileSync(join(directory, "tsconfig.json"), "utf8"),
		) as {
			compilerOptions: { types: Array<string> };
		};
		expect(tsconfig.compilerOptions.types).toContain("@maligator/cli");
		expect(starter.stdout.trim()).toBe("Hello, Maligator");
		expect(starter.stderr).toBe("");
	});

	it("reports a failed run and its application stack once", () => {
		writeFileSync(
			join(directory, "entry.mts"),
			'function fail() {\n  throw new Error("fixture failed");\n}\nfail();\n',
		);
		const run = invokeCli(directory, ["run", "entry.mts"]);
		expect(run.error, run.stderr).toBeUndefined();
		expect(run.status, run.stderr).toBe(1);
		expect(run.stderr).toMatch(/Exited with .*1/);
		expect(run.stderr).toMatch(/at fail .*entry\.mts:2:\d+/);
		expect(run.stderr.match(/fixture failed/g)).toHaveLength(1);
	});
});

describe("executeBinary", () => {
	it("streams successful stderr alongside stdout", async () => {
		let stdout = "";
		let stderr = "";
		const outcome = await executeBinaryReported(
			process.execPath,
			["-e", 'process.stdout.write("out"); process.stderr.write("note");'],
			process.env,
			{
				stdout: (text) => {
					stdout += text;
				},
				stderr: (text) => {
					stderr += text;
				},
			},
		);
		expect({ ...outcome, stdout, stderr }).toMatchObject({
			status: 0,
			stdout: "out",
			stderr: "note",
		});
	});

	it("stops a child that does not return before its deadline", async () => {
		expect(
			await executeBinaryReported(
				process.execPath,
				["-e", "setInterval(() => {}, 1000)"],
				process.env,
				{ timeoutMs: 100 },
			),
		).toMatchObject({ timedOut: true, signal: "SIGKILL" });
	});

	it("selects Guard Malloc from the supplied run environment", () => {
		const plain = { MAL_GMALLOC: "0" };
		expect(runEnv(plain)).toEqual(plain);
		expect(runEnv({ MAL_GMALLOC: "1" }).DYLD_INSERT_LIBRARIES).toBe(
			"/usr/lib/libgmalloc.dylib",
		);
	});
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

	it("streams output and preserves a non-zero status", async () => {
		let stdout = "";
		let stderr = "";
		const outcome = await executeBinaryReported(
			process.execPath,
			[
				"-e",
				`process.stdout.write("out"); process.stderr.write("err"); process.exit(23);`,
			],
			process.env,
			{
				stdout: (text) => {
					stdout += text;
				},
				stderr: (text) => {
					stderr += text;
				},
			},
		);
		expect({ ...outcome, stdout, stderr }).toEqual({
			status: 23,
			signal: undefined,
			stdout: "out",
			stderr: "err",
		});
	});

	it("separates result records from streamed application output", async () => {
		let stdout = "";
		const outcome = await executeBinaryReported(
			process.execPath,
			[
				"-e",
				`process.stdout.write("Rother\\nRE"); setTimeout(() => process.stdout.write('SULT {"ok":true}\\ntail'), 20);`,
			],
			process.env,
			{
				resultPrefix: "RESULT ",
				stdout: (text) => {
					stdout += text;
				},
			},
		);
		expect(outcome).toMatchObject({ status: 0, result: '{"ok":true}' });
		expect(stdout).toBe("Rother\ntail");
	});
});
