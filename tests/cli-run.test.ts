import { describe, expect, it } from "vitest";
import { runEnv } from "../src/build-flags.ts";
import { executeBinary, executeBinaryReported } from "../src/cli-run.ts";

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
