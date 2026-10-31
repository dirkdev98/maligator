import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FfiInspection, FunctionInspection } from "../src/ffi/inspect.ts";

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
		expect(shapes.types.find((type) => type.name === "ShapesBox")?.ts).toBe(
			"{ min: ShapesPoint; max: ShapesPoint }",
		);
	});

	it("names the missing fact for each declaration that cannot bind", () => {
		const gaps = (name: string) =>
			(declaration(name).gaps ?? []).map((gap) => `${gap.at}: ${gap.reason}`);
		expect(declaration("shapes_canvas_open").status).toBe("needs-facts");
		expect(gaps("shapes_canvas_open")).toEqual([
			"return: opaque pointer (ShapesCanvas *) needs a handle fact",
		]);
		expect(gaps("shapes_log")).toContain(
			"arguments: variadic arguments need a fact per call",
		);
		expect(gaps("shapes_path_length")).toEqual([
			"param 1 (path): struct ShapesPath: field 'points': pointer field (ShapesPoint *) needs an ownership fact",
		]);
		const text = inspect(shapesProject, ["shapes"]);
		expect(text.status).toBe(0);
		expect(text.stdout).toContain("shapes_canvas_open return: opaque pointer");
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
