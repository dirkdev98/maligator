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
	'other shapes [{"x":1,"y":2},{"x":1,"y":2},{"x":5,"y":1}]',
	"contains true false",
	"mode both null",
	"total 9007199254740994",
	"sum 6 twice 42",
	'constants 1.4 2.5 4294967296 {"x":0,"y":0}',
	"canvas Sketch null [object ShapesCanvas] open 1",
	"canvases after using 0",
	"text bytes 6,7,4,300",
	"log 8 3 points 13 origin at 2.5",
	"join one,two,three 93",
	"same handle true",
	"closed through either 0 true",
	"bitmap 3x2 sum 24 live 1",
	"bitmaps after free 0",
	"shared after dispose 4",
	'parse {"result":0,"point":{"x":3,"y":4}} -1',
	'scale {"point":{"x":3,"y":6}}',
	'bounds {"result":0,"box":{"min":{"x":-2,"y":3},"max":{"x":1,"y":5}}} -1',
	"checksum 256 24",
	"render 8 0,1,2,3,4,5,6,7",
	'corners [{"x":0,"y":0},{"x":4,"y":0},{"x":4,"y":3},{"x":0,"y":3}]',
	"describe (1.5, -2)",
	"created 0 Created",
	"allocations 0 canvases 0",
	"each 2 0:1,1:3",
	"integrate 9.0000",
	"callback threw stop here after 1 call",
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
			"rejected TypeError: shapes_each: visit expects a function",
			"rejected TypeError: shapes_checksum: data expects an ArrayBuffer or a view",
			"rejected TypeError: shapes_checksum: data expects a buffer that is not shared",
			"rejected TypeError: shapes_bounds: points.y expects a number",
			"rejected TypeError: shapes_bitmap_sum: bitmap expects an open ShapesBitmap handle",
			"rejected TypeError: shapes_canvas_title: canvas expects a ShapesCanvas handle or null",
			"rejected RangeError: shapes_twice: value expects an integer from -2147483648 to 2147483647",
			"rejected TypeError: shapes_twice: value expects a number",
			"rejected TypeError: shapes_total: a expects a bigint",
			"rejected TypeError: shapes_add: a.y expects a number",
			"rejected TypeError: shapes_text_bytes: text expects a string without NUL characters",
			"rejected RangeError: shapes_log_count: arg2 expects an integer from -2147483648 to 2147483647",
		]);
	});

	it("releases a dropped handle with collect when the garbage collector reclaims it", () => {
		writeFileSync(
			path.join(project, "collect.build.ts"),
			`export default ${JSON.stringify({
				entry: "collect.ts",
				engine: { eval: true, realms: true },
				surface: { node: true, webPlatform: true },
				ffi: { shapes: { contract: "shapes.ffi.ts" } },
			})};\n`,
		);
		const executed = cli(project, ["run", "--config", "collect.build.ts"]);
		expect(outputLines(executed.stdout)).toEqual([
			"open before collection 1",
			"open after collection 0",
		]);
	}, 600_000);

	it("runs tests that import the library", () => {
		const executed = cli(project, ["test", "shapes.test.ts"]);
		expect(executed.stdout).toContain("2 passed");
	}, 600_000);

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
