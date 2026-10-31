import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { planBindings } from "../src/ffi/binding-plan.ts";
import { extractCModel } from "../src/ffi/c-extract.ts";
import type { CModel } from "../src/ffi/c-model.ts";
import type { LibraryFacts } from "../src/ffi/contract.ts";
import { declarationsCurrent, generateDeclarations } from "../src/ffi/declarations.ts";
import type { FfiInspection, FunctionInspection } from "../src/ffi/inspect.ts";
import { loadCModel } from "../src/ffi/model-cache.ts";
import { suggestFacts } from "../src/ffi/suggest.ts";
import type { MaligatorFfiValueFacts } from "../src/public-api.d.ts";
import shapesContract from "./fixtures/ffi-shapes/shapes.ffi.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cliEntry = path.join(repoRoot, "src/index.ts");
const shapesProject = path.join(repoRoot, "tests/fixtures/ffi-shapes");
const shapesInclude = path.join(shapesProject, "include");

function inspect(cwd: string, args: Array<string>, env: NodeJS.ProcessEnv = process.env) {
	return spawnSync(process.execPath, [cliEntry, "ffi", "inspect", ...args], {
		cwd,
		env,
		encoding: "utf-8",
	});
}

function inspectJson(
	cwd: string,
	args: Array<string>,
	env: NodeJS.ProcessEnv = process.env,
): FfiInspection {
	const result = inspect(cwd, [...args, "--json"], env);
	expect(result.stderr).toBe("");
	expect(result.status).toBe(0);
	return JSON.parse(result.stdout) as FfiInspection;
}

describe("ffi inspect", () => {
	let shapes: FfiInspection;
	const declaration = (name: string): FunctionInspection =>
		shapes.functions.find((entry) => entry.name === name)!;
	const constant = (name: string) =>
		shapes.constants.find((entry) => entry.name === name);

	beforeAll(() => {
		shapes = inspectJson(shapesProject, ["shapes"]);
	});

	it("binds functions whose parameters and results pass by value", () => {
		expect(declaration("shapes_add")).toMatchObject({
			status: "bound",
			c: "ShapesPoint shapes_add(ShapesPoint a, ShapesPoint b);",
			ts: "(a: ShapesPoint, b: ShapesPoint) => ShapesPoint",
		});
		expect(declaration("shapes_total").ts).toBe("(a: bigint, b: bigint) => bigint");
		expect(declaration("shapes_contains").ts).toBe(
			"(box: ShapesBox, point: ShapesPoint) => boolean",
		);
		expect(declaration("shapes_mode_name").ts).toBe("(mode: number) => string | null");
		expect(declaration("shapes_twice")).toMatchObject({ status: "bound", inline: true });
		expect(declaration("shapes_mul")).toMatchObject({
			ts: "(value: number) => number",
			params: [{ name: "value" }, { name: "factor", role: "constant" }],
		});
		expect(shapes.types.find((type) => type.name === "ShapesBox")?.ts).toBe(
			"{ min: ShapesPoint; max: ShapesPoint }",
		);
	});

	it("names the missing fact for each declaration that cannot bind", () => {
		const gaps = (name: string) =>
			(declaration(name).gaps ?? []).map((gap) => `${gap.at}: ${gap.reason}`);
		expect(gaps("shapes_path_length")).toEqual([
			"param 1 (path): struct ShapesPath: field 'points' is a pointer (ShapesPoint *), so ShapesPath needs a handle fact",
		]);
		const text = inspect(shapesProject, ["shapes"]);
		expect(text.status).toBe(0);
		expect(text.stdout).toContain("shapes_path_length param 1 (path): struct ShapesPath");
	});

	it("reports a variadic function as the variants the contract declares", () => {
		expect(
			shapes.functions
				.filter((entry) => entry.variantOf === "shapes_log")
				.map(({ name, status, ts }) => ({ name, status, ts })),
		).toEqual([
			{
				name: "shapes_log_count",
				status: "bound",
				ts: "(format: string, arg2: number) => number",
			},
			{
				name: "shapes_log_pair",
				status: "bound",
				ts: "(format: string, arg2: string, arg3: number) => number",
			},
		]);
		expect(shapes.functions.map((entry) => entry.name)).not.toContain("shapes_log");
	});

	it("binds handle types from the contract's facts", () => {
		expect(shapes.handles).toEqual([
			{
				name: "ShapesCanvas",
				c: "struct ShapesCanvas",
				representation: "pointer",
				destroy: "shapes_canvas_close",
				collect: true,
				fields: [],
			},
			{
				name: "ShapesBitmap",
				c: "struct ShapesBitmap",
				representation: "struct",
				destroy: "shapes_bitmap_free",
				collect: false,
				doc: "A grayscale bitmap in memory the library allocates.",
				fields: [
					{ name: "width", c: "int", ts: "number" },
					{ name: "height", c: "int", ts: "number" },
				],
			},
		]);
		expect(declaration("shapes_canvas_open").ts).toBe(
			"(title: string) => ShapesCanvas | null",
		);
		expect(declaration("shapes_canvas_title").ts).toBe(
			"(canvas: ShapesCanvas | null) => string | null",
		);
		expect(declaration("shapes_bitmap_fill").ts).toBe(
			"(bitmap: ShapesBitmap, value: number) => void",
		);
	});

	it("returns outputs beside the result and hides counts", () => {
		expect(declaration("shapes_parse").ts).toBe(
			"(text: string) => { result: number; point: ShapesPoint }",
		);
		expect(declaration("shapes_scale").ts).toBe(
			"(point: ShapesPoint, factor: number) => { point: ShapesPoint }",
		);
		expect(declaration("shapes_bounds")).toMatchObject({
			ts: "(points: ReadonlyArray<ShapesPoint>) => { result: number; box: ShapesBox }",
			params: [{ role: "input" }, { role: "count of points" }, { role: "out" }],
		});
		expect(declaration("shapes_checksum").ts).toBe(
			"(data: ArrayBufferLike | ArrayBufferView) => number",
		);
		expect(declaration("shapes_render")).toMatchObject({
			ts: "(width: number, height: number) => Uint8Array | null",
			params: [{ role: "input" }, { role: "input" }, { role: "result-count" }],
		});
		expect(declaration("shapes_each")).toMatchObject({
			ts: "(points: ReadonlyArray<ShapesPoint>, visit: (arg1: ShapesPoint, arg2: number) => number) => number",
			params: [
				{ role: "input" },
				{ role: "count of points" },
				{ role: "input" },
				{ role: "callback-data" },
			],
		});
		expect(declaration("shapes_canvas_create").ts).toBe(
			"(title: string) => { result: number; canvas: ShapesCanvas | null }",
		);
	});

	it("names the contract in fact errors", () => {
		const project = mkdtempSync(path.join(os.tmpdir(), "mal-ffi-facts-"));
		try {
			cpSync(shapesProject, project, { recursive: true });
			writeFileSync(
				path.join(project, "shapes.ffi.ts"),
				`export default ${JSON.stringify({
					headers: ["shapes.h"],
					find: [{ sources: ["src/shapes.c"], includeDirs: ["include"] }],
					functions: { shapes_paint: {} },
				})};\n`,
			);
			const result = inspect(project, ["shapes"]);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(
				"shapes.ffi.ts: functions.shapes_paint: the headers declare no function 'shapes_paint'",
			);
		} finally {
			rmSync(project, { recursive: true, force: true });
		}
	});

	it("evaluates enum and macro constants without running code", () => {
		expect(constant("SHAPES_BOTH")).toMatchObject({
			c: "ShapesMode",
			ts: "number",
			value: 3,
		});
		expect(constant("SHAPES_BIG")).toMatchObject({ ts: "bigint", value: "4294967296" });
		expect(constant("SHAPES_SCALE")).toMatchObject({ ts: "number", value: 2.5 });
		expect(constant("SHAPES_VERSION")).toMatchObject({ ts: "string", value: "1.4" });
		expect(constant("SHAPES_ORIGIN")).toMatchObject({ ts: "ShapesPoint" });
		expect(constant("SHAPES_ORIGIN")).not.toHaveProperty("value");
		expect(constant("SHAPES_EXPORT")).toBeUndefined();
	});

	it("attaches trailing, preceding, and grouped doc comments", () => {
		expect(declaration("shapes_add").doc).toBe("Add two points.");
		expect(declaration("shapes_area").doc).toBe("Area of a box");
		expect(declaration("shapes_sum2").doc).toBe("Sum two or three integers.");
		expect(declaration("shapes_sum3")).toMatchObject({
			doc: "Sum two or three integers.",
			params: [{ doc: "First term" }, { doc: "Second term" }, { doc: "Third term" }],
		});
		expect(constant("SHAPES_FILL")?.doc).toBe("Fill the interior");
		expect(shapes.types.find((type) => type.name === "ShapesBox")?.doc).toBe(
			"Axis-aligned box",
		);
		expect(shapes.types.find((type) => type.name === "ShapesPoint")).toMatchObject({
			doc: "A point in the plane.",
			fields: [{ doc: "Horizontal position" }, { doc: "Vertical position" }],
		});
	});

	it("compiles a source-only library statically with its include directory", () => {
		expect(shapes.resolution).toEqual({
			method: "sources",
			link: "static",
			compileArguments: [`-I${shapesInclude}`],
			linkInputs: [],
			sources: [path.join(shapesProject, "src/shapes.c")],
		});
	});

	it("keeps the fixture's committed declarations current", () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), "mal-ffi-types-"));
		try {
			const outPath = path.join(directory, "maligator-ffi.d.ts");
			const result = spawnSync(
				process.execPath,
				[cliEntry, "ffi", "types", "--out", outPath],
				{ cwd: shapesProject, encoding: "utf-8" },
			);
			expect(result.stderr).toBe("");
			expect(result.status).toBe(0);
			expect(readFileSync(outPath, "utf8")).toBe(
				readFileSync(path.join(shapesProject, "maligator-ffi.d.ts"), "utf8"),
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("rejects a library the build config does not declare", () => {
		const result = inspect(shapesProject, ["canvas"]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("no ffi library 'canvas' in maligator.build.ts");
	});
});

describe("ffi library discovery", () => {
	let project: string;
	let libraryDirectory: string;
	let env: NodeJS.ProcessEnv;

	const writeConfig = (file: string, link?: "static" | "shared"): void => {
		const library = {
			contract: "shapes.ffi.ts",
			...(link === undefined ? {} : { link }),
		};
		writeFileSync(
			path.join(project, file),
			`export default ${JSON.stringify({ ffi: { shapes: library } })};\n`,
		);
	};

	beforeAll(() => {
		project = mkdtempSync(path.join(os.tmpdir(), "mal-ffi-discovery-"));
		libraryDirectory = path.join(project, "lib");
		mkdirSync(libraryDirectory);
		for (const file of ["libshapes.a", "libshapes.so", "libshapes.dylib"]) {
			writeFileSync(path.join(libraryDirectory, file), "");
		}
		// A stand-in pkg-config keeps the test independent of the host's package database.
		const pkgConfig = path.join(project, "pkg-config");
		writeFileSync(
			pkgConfig,
			[
				"#!/bin/sh",
				'case "$*" in',
				'  "--modversion shapes") echo 1.4.0 ;;',
				`  "--cflags shapes") echo "-I${shapesInclude}" ;;`,
				`  "--libs shapes") echo "-L${libraryDirectory} -lshapes" ;;`,
				`  "--static --libs shapes") echo "-L${libraryDirectory} -lshapes -lm" ;;`,
				'  *) echo "Package $2 was not found" >&2; exit 1 ;;',
				"esac",
				"",
			].join("\n"),
		);
		chmodSync(pkgConfig, 0o755);
		env = { ...process.env, PKG_CONFIG: pkgConfig };
		writeFileSync(
			path.join(project, "shapes.ffi.ts"),
			`export default ${JSON.stringify({
				headers: ["shapes.h"],
				find: [{ pkgConfig: "shapes-missing" }, { pkgConfig: "shapes" }],
			})};\n`,
		);
		writeConfig("maligator.build.ts");
		writeConfig("shared.build.ts", "shared");
	});

	afterAll(() => {
		rmSync(project, { recursive: true, force: true });
	});

	it("links the static archive and its private dependencies when an archive exists", () => {
		const inspection = inspectJson(project, ["shapes"], env);
		expect(inspection.resolution).toMatchObject({
			method: "pkg-config",
			package: "shapes",
			version: "1.4.0",
			link: "static",
			linkInputs: [
				{ kind: "archive", path: path.join(libraryDirectory, "libshapes.a") },
				{ kind: "system", name: "m" },
			],
		});
	});

	it("links the shared library when the build config asks for it", () => {
		const inspection = inspectJson(
			project,
			["shapes", "--config", "shared.build.ts"],
			env,
		);
		const extension = process.platform === "darwin" ? ".dylib" : ".so";
		expect(inspection.resolution).toMatchObject({
			link: "shared",
			linkInputs: [
				{
					kind: "shared",
					name: "shapes",
					path: path.join(libraryDirectory, `libshapes${extension}`),
					directory: libraryDirectory,
				},
			],
		});
	});

	it("reports each discovery alternative that failed", () => {
		writeFileSync(
			path.join(project, "missing.ffi.ts"),
			`export default ${JSON.stringify({
				headers: ["shapes.h"],
				find: [
					{ pkgConfig: "shapes-missing" },
					{ libraries: ["shapes"], sources: ["absent.c"] },
				],
			})};\n`,
		);
		writeFileSync(
			path.join(project, "missing.build.ts"),
			`export default ${JSON.stringify({ ffi: { shapes: { contract: "missing.ffi.ts" } } })};\n`,
		);
		const result = inspect(project, ["shapes", "--config", "missing.build.ts"], env);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("cannot find the C library 'shapes'");
		expect(result.stderr).toContain("Package shapes-missing was not found");
		expect(result.stderr).toContain(
			`source not found: ${path.join(project, "absent.c")}`,
		);
	});
});

describe("ffi contract facts", () => {
	let model: CModel;

	beforeAll(() => {
		const compiler = process.env.CC ?? "cc";
		const version = spawnSync(compiler, ["--version"], { encoding: "utf-8" }).stdout;
		model = extractCModel({
			compiler: { path: compiler, version: version.split("\n")[0] ?? "" },
			environment: process.env,
			headers: ["shapes.h"],
			compileArguments: [`-I${shapesInclude}`],
		});
	});

	const rejects = (facts: Partial<LibraryFacts>, message: string): void => {
		expect(() => planBindings(model, { types: {}, functions: {}, ...facts })).toThrow(
			message,
		);
	};

	it("suggests the count, output, result, callback, and handle facts the fixture contract states", () => {
		const suggestions = suggestFacts(
			model,
			{ types: {}, functions: {} },
			planBindings(model),
		);
		const contract: LibraryFacts = shapesContract;
		const suggestedKinds = new Set([
			"array",
			"bytes",
			"out",
			"inout",
			"callback",
			"string",
			"free",
		]);
		// Suggestions do not cover facts on a callback's own parameters.
		const suggestible = (facts: MaligatorFfiValueFacts): boolean =>
			Object.keys(facts).every((kind) => suggestedKinds.has(kind)) &&
			facts.callback?.params === undefined;
		const stated = Object.entries(contract.functions).filter(
			([, facts]) =>
				facts.variants === undefined &&
				Object.values(facts.params ?? {}).every(suggestible) &&
				suggestible(facts.returns ?? {}),
		);

		expect(suggestions.functions).toEqual(Object.fromEntries(stated));
		expect(
			Object.fromEntries(
				Object.entries(suggestions.types).map(([name, facts]) => [
					name,
					facts.handle?.destroy,
				]),
			),
		).toEqual(
			Object.fromEntries(
				Object.entries(contract.types).map(([name, facts]) => [
					name,
					facts.handle?.destroy,
				]),
			),
		);
		expect(planBindings(model, contract).functions.map((entry) => entry.name)).toEqual(
			expect.arrayContaining([...suggestions.binds]),
		);
	});

	it("needs a variant fact to bind a variadic function", () => {
		const log = planBindings(model).unbound.find((entry) => entry.name === "shapes_log");
		expect(log?.gaps).toContainEqual({
			at: "arguments",
			reason: "variadic arguments need a fact per call",
		});
	});

	it("tells current declarations from stale ones, however they are formatted", () => {
		const contract: LibraryFacts = shapesContract;
		const libraries = [{ name: "shapes", plan: planBindings(model, contract) }];
		const text = generateDeclarations(libraries);

		expect(declarationsCurrent(text, libraries)).toBe(true);
		expect(
			declarationsCurrent(text.replaceAll("\t", "  ").replaceAll('"', "'"), libraries),
		).toBe(true);
		expect(
			declarationsCurrent(text, [{ name: "shapes", plan: planBindings(model) }]),
		).toBe(false);
	});

	it("rejects a constant combined with another fact or on a result", () => {
		rejects(
			{
				functions: {
					shapes_mul: { params: { factor: { constant: "0", nullable: true } } },
				},
			},
			"functions.shapes_mul.params.factor: a constant parameter takes no other role",
		);
		rejects(
			{ functions: { shapes_mul: { returns: { constant: "0" } } } },
			"functions.shapes_mul.returns.constant: constant applies to parameters",
		);
	});

	it("rejects callback parameter facts that do not fit the callback", () => {
		const reader = (params: Record<string, MaligatorFfiValueFacts>) => ({
			functions: {
				shapes_read: { params: { reader: { callback: { data: "data", params } } } },
			},
		});
		rejects(
			reader({ 3: { out: true } }),
			"functions.shapes_read.params.reader.callback.params.3: out does not apply to callback parameters",
		);
		rejects(
			reader({ 3: { array: { length: "3" } } }),
			"functions.shapes_read.params.reader.callback.params.3: length '3' is not another integer parameter's 1-based position",
		);
	});

	it("rejects a callback release that is not a destructor parameter", () => {
		rejects(
			{
				functions: {
					shapes_listen: {
						params: { listener: { callback: { data: "data", release: "data" } } },
					},
				},
			},
			"functions.shapes_listen.params.listener.callback.release: 'data' is not a free void (*)(void *) parameter",
		);
	});

	it("rejects variants that do not fit their declaration", () => {
		rejects(
			{ functions: { shapes_add: { variants: { shapes_add_more: { args: ["int"] } } } } },
			"functions.shapes_add.variants.shapes_add_more: shapes_add is not variadic",
		);
		rejects(
			{ functions: { shapes_log: { variants: { shapes_twice: { args: ["int"] } } } } },
			"functions.shapes_log.variants.shapes_twice: 'shapes_twice' is already a function",
		);
		rejects(
			{
				functions: { shapes_log: { variants: { shapes_log_odd: { args: ["odd_t"] } } } },
			},
			"functions.shapes_log.variants.shapes_log_odd.args[0]: 'odd_t' is not a C type",
		);
	});

	it("rejects facts that name nothing in the headers", () => {
		rejects(
			{ functions: { shapes_paint: {} } },
			"functions.shapes_paint: the headers declare no function 'shapes_paint'",
		);
		rejects(
			{ functions: { shapes_add: { params: { c: { nullable: true } } } } },
			"functions.shapes_add.params.c: shapes_add has no such parameter",
		);
		rejects(
			{ types: { ShapesShadow: { handle: {} } } },
			"types.ShapesShadow: the headers declare no struct named 'ShapesShadow'",
		);
	});

	it("rejects facts that do not fit their declaration", () => {
		rejects(
			{ types: { ShapesBitmap: { handle: { destroy: "shapes_canvas_close" } } } },
			"types.ShapesBitmap.handle.destroy: shapes_canvas_close must take only a ShapesBitmap",
		);
		rejects(
			{ functions: { shapes_area: { returns: { borrowed: true } } } },
			"functions.shapes_area.returns.borrowed: the result is not a handle",
		);
		rejects(
			{ functions: { shapes_area: { returns: { free: "shapes_free" } } } },
			"functions.shapes_area.returns.free: free applies to string, buffer, and array results",
		);
		rejects(
			{
				functions: {
					shapes_corners: {
						returns: { array: { length: "count" }, free: "shapes_area" },
					},
				},
			},
			"functions.shapes_corners.returns.free: 'shapes_area' is not a function that takes one pointer",
		);
		rejects(
			{
				functions: {
					shapes_bounds: { params: { points: { bytes: { length: "count" } } } },
				},
			},
			"functions.shapes_bounds.params.points: bytes applies to void and byte pointers, not const ShapesPoint *",
		);
		rejects(
			{ functions: { shapes_sum2: { params: { a: { string: true } } } } },
			"functions.shapes_sum2.params.a: string applies to pointers, not int",
		);
	});
});

describe("C model cache", () => {
	it("reads the headers again only after one of them or the header search changes", () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), "mal-ffi-model-cache-"));
		const previousCache = process.env.MALIGATOR_CACHE_DIR;
		try {
			const include = path.join(directory, "include");
			cpSync(shapesInclude, include, { recursive: true });
			const log = path.join(directory, "compiler.log");
			const wrapper = path.join(directory, "cc");
			const compiler = process.env.CC ?? "cc";
			writeFileSync(wrapper, `#!/bin/sh\necho "$@" >> '${log}'\nexec ${compiler} "$@"\n`);
			chmodSync(wrapper, 0o755);
			process.env.MALIGATOR_CACHE_DIR = path.join(directory, "cache");
			const version = spawnSync(compiler, ["--version"], { encoding: "utf-8" }).stdout;
			const input = {
				compiler: { path: wrapper, version: version.split("\n")[0] ?? "" },
				environment: process.env,
				headers: ["shapes.h"],
				compileArguments: [`-I${include}`],
			};
			const astDumps = () =>
				readFileSync(log, "utf8")
					.split("\n")
					.filter((line) => line.includes("-ast-dump")).length;

			loadCModel(input);
			const first = astDumps();
			loadCModel(input);
			expect(astDumps()).toBe(first);

			appendFileSync(path.join(include, "shapes.h"), "int shapes_extra(int value);\n");
			const changed = loadCModel(input);
			expect(astDumps()).toBeGreaterThan(first);
			expect(changed.functions.map((entry) => entry.name)).toContain("shapes_extra");

			const edited = astDumps();
			loadCModel({ ...input, environment: { ...process.env, CPATH: include } });
			expect(astDumps()).toBeGreaterThan(edited);
		} finally {
			if (previousCache === undefined) delete process.env.MALIGATOR_CACHE_DIR;
			else process.env.MALIGATOR_CACHE_DIR = previousCache;
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
