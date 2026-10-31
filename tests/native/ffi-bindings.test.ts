import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const cliEntry = path.join(repositoryRoot, "src/index.ts");
const fixture = path.join(repositoryRoot, "tests/fixtures/ffi-shapes");

/** The fixture program's results, which do not depend on how the library was linked. */
const EXPECTED_RESULTS = [
	'add {"x":4,"y":6.5}',
	"area 12",
	"contains true false",
	"mode both null",
	"total 9007199254740994",
	"sum 6 twice 42",
	'constants 1.4 2.5 4294967296 {"x":0,"y":0}',
];

function cli(cwd: string, args: Array<string>) {
	const result = spawnSync(process.execPath, [cliEntry, ...args], {
		cwd,
		env: process.env,
		encoding: "utf-8",
		timeout: 600_000,
	});
	expect(result.status, result.stderr || result.stdout).toBe(0);
	return result;
}

function outputLines(stdout: string): Array<string> {
	return stdout.split("\n").filter((line) => line !== "");
}

describe("C library bindings", () => {
	let project: string;
	let runOutput: Array<string>;

	beforeAll(() => {
		project = mkdtempSync(path.join(os.tmpdir(), "mal-ffi-bindings-"));
		cpSync(fixture, project, { recursive: true });
		runOutput = outputLines(cli(project, ["run"]).stdout);
	}, 600_000);

	afterAll(() => {
		rmSync(project, { recursive: true, force: true });
	});

	it("passes structs, integers, strings, and constants by value", () => {
		expect(runOutput.slice(0, EXPECTED_RESULTS.length)).toEqual(EXPECTED_RESULTS);
	});

	it("rejects arguments that do not convert exactly", () => {
		expect(
			runOutput.filter((line) => line.startsWith("rejected") || line === "accepted"),
		).toEqual([
			"rejected RangeError: shapes_twice: value expects an integer from -2147483648 to 2147483647",
			"rejected TypeError: shapes_twice: value expects a number",
			"rejected TypeError: shapes_total: a expects a bigint",
			"rejected TypeError: shapes_add: a.y expects a number",
		]);
	});

	it("links bindings into a production binary", () => {
		const built = cli(project, ["build", "--production"]);
		const binary = outputLines(built.stdout).at(-1)!;
		const executed = spawnSync(binary, [], { encoding: "utf-8", timeout: 60_000 });
		expect(executed.status, executed.stderr).toBe(0);
		expect(outputLines(executed.stdout).slice(0, EXPECTED_RESULTS.length)).toEqual(
			EXPECTED_RESULTS,
		);
	}, 600_000);

	it("links a shared library and loads it from where it was found", () => {
		const libraryDirectory = path.join(project, "lib");
		mkdirSync(libraryDirectory);
		const extension = process.platform === "darwin" ? "dylib" : "so";
		const compiled = spawnSync(
			process.env.CC ?? "cc",
			[
				"-shared",
				"-fPIC",
				"-I",
				path.join(project, "include"),
				path.join(project, "src/shapes.c"),
				"-o",
				path.join(libraryDirectory, `libshapes.${extension}`),
			],
			{ encoding: "utf-8" },
		);
		expect(compiled.status, compiled.stderr).toBe(0);
		writeFileSync(
			path.join(project, "shared.build.ts"),
			`export default ${JSON.stringify({
				entry: "main.ts",
				ffi: {
					shapes: {
						contract: "shapes.ffi.ts",
						find: {
							includeDirs: ["include"],
							libraryDirs: ["lib"],
							libraries: ["shapes"],
						},
						link: "shared",
					},
				},
			})};\n`,
		);
		const executed = cli(project, ["run", "--config", "shared.build.ts"]);
		expect(outputLines(executed.stdout).slice(0, EXPECTED_RESULTS.length)).toEqual(
			EXPECTED_RESULTS,
		);
	}, 600_000);
});
