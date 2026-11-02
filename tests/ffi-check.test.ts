import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FfiCheckReport } from "../src/ffi/check.ts";
import type { LibraryFacts } from "../src/ffi/contract.ts";

const cliEntry = path.resolve(import.meta.dirname, "../src/index.ts");
const temporary: Array<string> = [];
const header = `
typedef unsigned short ShapesIndex;
typedef struct ShapesPoint { double x; double y; } ShapesPoint;
typedef struct { ShapesPoint min; ShapesPoint max; } ShapesBox;
typedef struct { struct { float value; } nested; } ShapesPacket;
int shapes_index(ShapesIndex value);
int shapes_contains(ShapesBox box);
int shapes_packet(ShapesPacket packet);
const char *shapes_name(void);
`;

function project(libraries: ReadonlyArray<string> = ["shapes"]): string {
	const directory = mkdtempSync(path.join(os.tmpdir(), "mal-ffi-check-"));
	temporary.push(directory);
	mkdirSync(path.join(directory, "include"));
	writeFileSync(path.join(directory, "include/shapes.h"), header);
	writeFileSync(path.join(directory, "shapes.c"), "");
	writeContract(directory);
	writeFileSync(
		path.join(directory, "maligator.build.ts"),
		`export default ${JSON.stringify({
			ffi: Object.fromEntries(
				libraries.map((name) => [name, { contract: "shapes.ffi.ts" }]),
			),
		})};\n`,
	);
	return directory;
}

function writeContract(directory: string, facts: Partial<LibraryFacts> = {}): void {
	writeFileSync(
		path.join(directory, "shapes.ffi.ts"),
		`export default ${JSON.stringify({
			headers: ["shapes.h"],
			find: [{ includeDirs: ["include"], sources: ["shapes.c"] }],
			...facts,
		})};\n`,
	);
}

function cli(directory: string, args: ReadonlyArray<string>) {
	return spawnSync(process.execPath, [cliEntry, "ffi", ...args], {
		cwd: directory,
		encoding: "utf8",
		timeout: 30_000,
	});
}

function check(
	directory: string,
	args: ReadonlyArray<string> = [],
	status = 0,
): FfiCheckReport {
	const result = cli(directory, ["check", ...args, "--json"]);
	expect(result.status, result.stderr || result.stdout).toBe(status);
	return JSON.parse(result.stdout) as FfiCheckReport;
}

function accept(directory: string): void {
	expect(check(directory, ["--update"]).ok).toBe(true);
}

afterEach(() => {
	for (const directory of temporary.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("ffi check", () => {
	it("detects typedef alignment changes while the underlying record and SDK stay unchanged", () => {
		const directory = project();
		const file = path.join(directory, "include/shapes.h");
		const declarations = `${header}\ntypedef struct ShapesAliased { int values[16]; } ShapesAligned __attribute__((aligned(16)));\nShapesAligned shapes_aligned(ShapesAligned value);\n`;
		writeFileSync(file, declarations);
		accept(directory);
		expect(cli(directory, ["types"]).status).toBe(0);
		const types = readFileSync(path.join(directory, "maligator-ffi.d.ts"), "utf8");
		writeFileSync(file, declarations.replace("aligned(16)", "aligned(32)"));
		expect(cli(directory, ["types"]).status).toBe(0);
		expect(readFileSync(path.join(directory, "maligator-ffi.d.ts"), "utf8")).toBe(types);
		expect(check(directory, [], 1).libraries[0]?.changes).toContainEqual({
			path: "declarations.typedef ShapesAligned.alignmentBits",
			kind: "changed",
			before: 128,
			after: 256,
		});
	});

	it.each([
		{
			name: "packing",
			before: "struct ShapesAbi { char marker; int value; };",
			after:
				"#pragma pack(push, 1)\nstruct ShapesAbi { char marker; int value; };\n#pragma pack(pop)",
			property: "sizeBits",
			beforeValue: 64,
			afterValue: 40,
		},
		{
			name: "alignment with unchanged size",
			before: "struct __attribute__((aligned(16))) ShapesAbi { int values[16]; };",
			after: "struct __attribute__((aligned(32))) ShapesAbi { int values[16]; };",
			property: "alignmentBits",
			beforeValue: 128,
			afterValue: 256,
		},
		{
			name: "field offsets with unchanged size and alignment",
			before:
				"struct __attribute__((aligned(16))) ShapesAbi { char marker; int value; };",
			after:
				"struct __attribute__((packed,aligned(16))) ShapesAbi { char marker; int value; };",
			property: "fieldOffsetsBits",
			beforeValue: [0, 32],
			afterValue: [0, 8],
		},
	])(
		"detects $name while generated JavaScript types stay unchanged",
		({ before, after, property, beforeValue, afterValue }) => {
			const directory = project();
			const file = path.join(directory, "include/shapes.h");
			const declarations = (record: string) =>
				`${header}\n${record}\nstruct ShapesAbi shapes_layout(struct ShapesAbi value);\n`;
			writeFileSync(file, declarations(before));
			accept(directory);
			expect(cli(directory, ["types"]).status).toBe(0);
			const types = readFileSync(path.join(directory, "maligator-ffi.d.ts"), "utf8");
			writeFileSync(file, declarations(after));
			expect(cli(directory, ["types"]).status).toBe(0);
			expect(readFileSync(path.join(directory, "maligator-ffi.d.ts"), "utf8")).toBe(
				types,
			);
			expect(check(directory, [], 1).libraries[0]?.changes).toContainEqual({
				path: `declarations.struct ShapesAbi.layout.${property}`,
				kind: "changed",
				before: beforeValue,
				after: afterValue,
			});
		},
	);

	it("refuses to approve conflicting layouts with the same scoped tag name", () => {
		const directory = project();
		appendFileSync(
			path.join(directory, "include/shapes.h"),
			`
void private_prototype(struct ShapesAbi { double other; } value);
struct ShapesAbi { char marker; int value; };
struct ShapesAbi shapes_layout(struct ShapesAbi value);
`,
		);
		const result = cli(directory, ["check", "--update"]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("cannot snapshot struct ShapesAbi");
		expect(existsSync(path.join(directory, "maligator-ffi.lock.json"))).toBe(false);
	});

	it("watches packing for a record used only by a hidden sizeof argument", () => {
		const directory = project();
		const file = path.join(directory, "include/shapes.h");
		const declarations = `${header}\ntypedef struct ShapesAbi { char marker; int value; } ShapesAbi;\nint shapes_abi(int size);\n`;
		writeFileSync(file, declarations);
		writeContract(directory, {
			functions: { shapes_abi: { params: { size: { sizeof: "ShapesAbi" } } } },
		});
		accept(directory);
		writeFileSync(file, `#pragma pack(push, 1)\n${declarations}\n#pragma pack(pop)\n`);
		expect(check(directory, [], 1).libraries[0]?.changes).toContainEqual({
			path: "declarations.struct ShapesAbi.layout.sizeBits",
			kind: "changed",
			before: 64,
			after: 40,
		});
	});

	it("detects a bit-field width change when its TypeScript type stays the same", () => {
		const directory = project();
		const file = path.join(directory, "include/shapes.h");
		const declarations = `${header}\ntypedef struct ShapesBits { unsigned value:3; } ShapesBits;\nShapesBits shapes_bits(ShapesBits value);\n`;
		writeFileSync(file, declarations);
		accept(directory);
		expect(cli(directory, ["types"]).status).toBe(0);
		const types = readFileSync(path.join(directory, "maligator-ffi.d.ts"), "utf8");
		writeFileSync(file, declarations.replace("value:3", "value:4"));
		expect(cli(directory, ["types"]).status).toBe(0);
		expect(readFileSync(path.join(directory, "maligator-ffi.d.ts"), "utf8")).toBe(types);
		expect(
			check(directory, [], 1).libraries[0]?.changes.find(
				(change) => change.path === "declarations.struct ShapesBits.fields",
			),
		).toMatchObject({
			kind: "changed",
			before: [{ bitWidth: 3 }],
			after: [{ bitWidth: 4 }],
		});
	});
	it("watches pointer-valued macros reached through fixed argument aliases", () => {
		const directory = project();
		const headerPath = path.join(directory, "include/shapes.h");
		const privateHeader = path.join(directory, "include/private.h");
		writeFileSync(privateHeader, "#define SHAPES_CALLBACK_BASE ((void (*)(void))0)\n");
		const macros = `${header}\n#include "private.h"\n#define SHAPES_CALLBACK SHAPES_CALLBACK_BASE\nvoid shapes_callback(void (*callback)(void));\n`;
		writeFileSync(headerPath, macros);
		writeContract(directory, {
			functions: {
				shapes_callback: { params: { callback: { constant: "SHAPES_CALLBACK" } } },
			},
		});
		accept(directory);
		writeFileSync(privateHeader, "#define SHAPES_CALLBACK_BASE ((void (*)(void))1)\n");
		expect(check(directory, [], 1).libraries[0]?.changes).toContainEqual({
			path: "declarations.macro SHAPES_CALLBACK_BASE.body",
			kind: "changed",
			before: "((void (*)(void))0)",
			after: "((void (*)(void))1)",
		});
	});

	it("watches macros formed by token pasting without exporting private helpers", () => {
		const directory = project();
		const privateHeader = path.join(directory, "include/private.h");
		const definitions =
			"#define JOIN_INNER(a,b) a##b\n#define JOIN(a,b) JOIN_INNER(a,b)\n#define PRIVATE_CODE 7\n#define PRIVATE_UNRELATED 2\n";
		writeFileSync(privateHeader, definitions);
		appendFileSync(
			path.join(directory, "include/shapes.h"),
			'\n#include "private.h"\n#define SHAPES_CODE JOIN(PRIVATE_,CODE)\n',
		);
		accept(directory);
		const inspected = cli(directory, ["inspect", "shapes", "--json"]);
		expect(inspected.status, inspected.stderr).toBe(0);
		const inspection = JSON.parse(inspected.stdout) as {
			constants: Array<{ name: string }>;
			skippedConstants: Array<{ name: string }>;
		};
		expect(inspection.constants.map(({ name }) => name)).toContain("SHAPES_CODE");
		expect(
			[...inspection.constants, ...inspection.skippedConstants].some(
				({ name }) => name.startsWith("PRIVATE_") || name.startsWith("JOIN"),
			),
		).toBe(false);
		writeFileSync(
			privateHeader,
			definitions.replace("PRIVATE_UNRELATED 2", "PRIVATE_UNRELATED 3"),
		);
		expect(check(directory).ok).toBe(true);
		writeFileSync(privateHeader, definitions.replace("PRIVATE_CODE 7", "PRIVATE_CODE 8"));
		expect(check(directory, [], 1).libraries[0]?.changes).toContainEqual({
			path: "declarations.macro SHAPES_CODE.expansion",
			kind: "changed",
			before: '"7"',
			after: '"8"',
		});
	});

	it("tracks private macros used only by a variadic variant", () => {
		const directory = project();
		const privateHeader = path.join(directory, "include/private.h");
		writeFileSync(privateHeader, '#define PRIVATE_FORMAT "%d"\n');
		appendFileSync(
			path.join(directory, "include/shapes.h"),
			'\n#include "private.h"\nint shapes_log(int selector, ...);\n',
		);
		writeContract(directory, {
			functions: {
				shapes_log: {
					variants: {
						shapes_log_int: {
							params: { arg2: { constant: "PRIVATE_FORMAT" } },
							args: ["const char *"],
						},
					},
				},
			},
		});
		accept(directory);
		writeFileSync(privateHeader, '#define PRIVATE_FORMAT "%x"\n');
		expect(
			check(directory, [], 1).libraries[0]?.changes.some(
				(change) => change.path === "declarations.macro PRIVATE_FORMAT.body",
			),
		).toBe(true);
	});

	it("tracks function-like macro evidence without treating its parameters or strings as dependencies", () => {
		const directory = project();
		const privateHeader = path.join(directory, "include/private.h");
		const definitions =
			'#define VALUE 9\n#define LITERAL 3\n/** Select the supplied value. */\n#define PRIVATE_SELECT(VALUE) (VALUE + sizeof("LITERAL"))\n';
		writeFileSync(privateHeader, definitions);
		appendFileSync(path.join(directory, "include/shapes.h"), '\n#include "private.h"\n');
		writeContract(directory, {
			functions: {
				shapes_name: { evidence: [{ kind: "macro", name: "PRIVATE_SELECT" }] },
			},
		});
		accept(directory);
		writeFileSync(
			privateHeader,
			definitions.replace("VALUE 9", "VALUE 10").replace("LITERAL 3", "LITERAL 4"),
		);
		expect(check(directory).ok).toBe(true);
		writeFileSync(privateHeader, definitions.replace("VALUE + sizeof", "VALUE - sizeof"));
		expect(
			check(directory, [], 1).libraries[0]?.changes.some(
				(change) => change.path === "declarations.macro PRIVATE_SELECT.body",
			),
		).toBe(true);
	});

	it("keeps context-dependent macros out of declarations and checks their definitions consistently", () => {
		const directory = project();
		appendFileSync(
			path.join(directory, "include/shapes.h"),
			`
#define SHAPES_COUNTER __COUNTER__
#define SHAPES_SOURCE_LINE __builtin_LINE()
#define JOIN_INNER(a,b) a##b
#define JOIN(a,b) JOIN_INNER(a,b)
/** The caller's source file. */
#define SHAPES_FILE JOIN(__FI,LE__)
#pragma clang diagnostic ignored "-Wdate-time"
#define SHAPES_TIME __TIME__
#define SHAPES_LITERAL "__FILE__"
`,
		);
		writeContract(directory, {
			functions: { shapes_name: { evidence: [{ kind: "macro", name: "SHAPES_FILE" }] } },
		});
		accept(directory);
		expect(check(directory).ok).toBe(true);
		const result = cli(directory, ["types"]);
		expect(result.status, result.stderr).toBe(0);
		const declarations = readFileSync(path.join(directory, "maligator-ffi.d.ts"), "utf8");
		for (const name of [
			"SHAPES_COUNTER",
			"SHAPES_FILE",
			"SHAPES_TIME",
			"SHAPES_SOURCE_LINE",
		])
			expect(declarations).not.toContain(name);
		expect(declarations).toContain("SHAPES_LITERAL");
	});

	it.each(["__COUNTER__", "__builtin_LINE()"])(
		"rejects a cleanup success code that depends on %s",
		(expression) => {
			const directory = project();
			appendFileSync(
				path.join(directory, "include/shapes.h"),
				`\n#define SHAPES_SUCCESS ${expression}\ntypedef struct BusyResource BusyResource;\nint resource_close(BusyResource *resource);\n`,
			);
			writeContract(directory, {
				types: {
					BusyResource: {
						handle: {
							destroy: { function: "resource_close", success: "SHAPES_SUCCESS" },
						},
					},
				},
			});
			const result = cli(directory, ["check", "--update"]);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("known integer constant");
		},
	);

	it("watches cleanup success codes from a transitive enum header", () => {
		const directory = project();
		writeFileSync(
			path.join(directory, "include/status.h"),
			"enum ReleaseStatus { STATUS_OK = 0 };\n",
		);
		appendFileSync(
			path.join(directory, "include/shapes.h"),
			'#include "status.h"\ntypedef struct BusyResource BusyResource;\nBusyResource *resource_open(void);\nint resource_close(BusyResource *resource);\n',
		);
		writeContract(directory, {
			types: {
				BusyResource: {
					handle: { destroy: { function: "resource_close", success: "STATUS_OK" } },
				},
			},
		});
		accept(directory);
		writeFileSync(
			path.join(directory, "include/status.h"),
			"enum ReleaseStatus { STATUS_OK = 2 };\n",
		);
		const report = check(directory, [], 1);
		expect(report.ok).toBe(false);
		expect(
			report.libraries[0]?.changes.some((change) => change.path.includes("STATUS_OK")),
		).toBe(true);
	});
	it("requires an explicit update before accepting a library's declarations", () => {
		const directory = project();
		const lock = path.join(directory, "maligator-ffi.lock.json");
		expect(check(directory, [], 1).libraries).toMatchObject([
			{ library: "shapes", status: "missing" },
		]);
		expect(existsSync(lock)).toBe(false);
		accept(directory);
		const before = readFileSync(lock, "utf8");
		expect(check(directory).ok).toBe(true);
		expect(readFileSync(lock, "utf8")).toBe(before);
	});

	it("detects a changed C integer type even when its TypeScript declaration is unchanged", () => {
		const directory = project();
		accept(directory);
		expect(cli(directory, ["types"]).status).toBe(0);
		const declarations = readFileSync(path.join(directory, "maligator-ffi.d.ts"), "utf8");
		writeFileSync(
			path.join(directory, "include/shapes.h"),
			header.replace("unsigned short", "unsigned int"),
		);
		expect(cli(directory, ["types"]).status).toBe(0);
		expect(readFileSync(path.join(directory, "maligator-ffi.d.ts"), "utf8")).toBe(
			declarations,
		);
		const report = check(directory, [], 1);
		expect(report.libraries[0]?.changes).toContainEqual({
			path: "declarations.typedef ShapesIndex.type.name",
			kind: "changed",
			before: "unsigned short",
			after: "unsigned int",
		});
		accept(directory);
		expect(check(directory).ok).toBe(true);
	});

	it("detects changes in a record nested inside an exported parameter", () => {
		const directory = project();
		accept(directory);
		writeFileSync(
			path.join(directory, "include/shapes.h"),
			header.replace("double x", "float x"),
		);
		const report = check(directory, [], 1);
		expect(
			report.libraries[0]?.changes.some((change) =>
				change.path.includes("struct ShapesPoint"),
			),
		).toBe(true);
		const text = cli(directory, ["check"]);
		expect(text.status).toBe(1);
		expect(text.stdout).toContain("ShapesPoint");
		expect(text.stdout).toContain('"double"');
		expect(text.stdout).toContain('"float"');
	});

	it("ignores source locations, comments, and unrelated declarations", () => {
		const directory = project();
		accept(directory);
		writeFileSync(
			path.join(directory, "include/shapes.h"),
			`// Moved declarations.\n\n${header}\nvoid shapes_unmapped(void *data);\n`,
		);
		const relocated = project();
		cpSync(directory, relocated, { recursive: true });
		expect(check(relocated).ok).toBe(true);
	});

	it("follows recursive handle types without depending on their source location", () => {
		const directory = project();
		const recursive = `${header}\ntypedef struct ShapesNode { int value; struct ShapesNode *next; } ShapesNode;\n`;
		const headerPath = path.join(directory, "include/shapes.h");
		writeFileSync(headerPath, recursive);
		writeContract(directory, { types: { ShapesNode: { handle: {} } } });
		accept(directory);
		writeFileSync(headerPath, `\n${recursive}`);
		expect(check(directory).ok).toBe(true);
		writeFileSync(headerPath, recursive.replace("int value", "long value"));
		expect(
			check(directory, [], 1).libraries[0]?.changes.some((change) =>
				change.path.includes("struct ShapesNode"),
			),
		).toBe(true);
	});

	it("watches typedefs named by handle views", () => {
		const directory = project();
		const headerPath = path.join(directory, "include/shapes.h");
		const views = `${header}
typedef struct ShapesBase { int value; } ShapesBase;
typedef struct ShapesOther { int value; } ShapesOther;
typedef struct ShapesDerived { ShapesBase base; } ShapesDerived;
typedef ShapesBase ShapesView;
`;
		writeFileSync(headerPath, views);
		writeContract(directory, {
			types: {
				ShapesBase: { handle: {} },
				ShapesOther: { handle: {} },
				ShapesDerived: { handle: { views: ["ShapesView"] } },
			},
		});
		accept(directory);
		writeFileSync(
			headerPath,
			views.replace("typedef ShapesBase ShapesView", "typedef ShapesOther ShapesView"),
		);
		expect(
			check(directory, [], 1).libraries[0]?.changes.some((change) =>
				change.path.includes("typedef ShapesView"),
			),
		).toBe(true);
	});

	it("watches types used only for fixed ABI sizes", () => {
		const directory = project();
		const headerPath = path.join(directory, "include/shapes.h");
		const sized = `${header}\ntypedef struct ShapesAbi { char bytes[24]; } ShapesAbi;\nint shapes_abi(int size);\n`;
		writeFileSync(headerPath, sized);
		writeContract(directory, {
			functions: { shapes_abi: { params: { size: { sizeof: "ShapesAbi" } } } },
		});
		accept(directory);
		writeFileSync(headerPath, sized.replace("bytes[24]", "bytes[32]"));
		expect(
			check(directory, [], 1).libraries[0]?.changes.some((change) =>
				change.path.includes("ShapesAbi"),
			),
		).toBe(true);
	});

	it("checks a result's release function even when it is not exported", () => {
		const directory = project();
		const headerPath = path.join(directory, "include/shapes.h");
		const release = `${header}\nvoid shapes_release(void *memory);\n`;
		writeFileSync(headerPath, release);
		writeContract(directory, {
			functions: { shapes_name: { returns: { free: "shapes_release" } } },
		});
		accept(directory);
		writeFileSync(headerPath, release.replace("void *memory", "char *memory"));
		expect(
			check(directory, [], 1).libraries[0]?.changes.some((change) =>
				change.path.includes("function shapes_release"),
			),
		).toBe(true);
	});

	it("requires review when accepted ownership or conversion facts change", () => {
		const directory = project();
		accept(directory);
		writeContract(directory, {
			functions: { shapes_name: { returns: { nullable: false } } },
		});
		const report = check(directory, [], 1);
		expect(report.libraries[0]?.changes).toContainEqual(
			expect.objectContaining({
				path: "facts.functions.shapes_name",
				kind: "added",
			}),
		);
	});

	it("requires review when cited header documentation changes", () => {
		const directory = project();
		const headerPath = path.join(directory, "include/shapes.h");
		const documented = header.replace(
			"const char *shapes_name",
			"// Returns a borrowed name that is never NULL.\nconst char *shapes_name",
		);
		writeFileSync(headerPath, documented);
		writeContract(directory, {
			functions: {
				shapes_name: {
					returns: { nullable: false },
					evidence: [{ kind: "function", name: "shapes_name" }],
				},
			},
		});
		accept(directory);
		const lock = path.join(directory, "maligator-ffi.lock.json");
		const before = readFileSync(lock, "utf8");
		writeFileSync(headerPath, documented.replace("never NULL", "sometimes NULL"));
		expect(check(directory, [], 1).libraries[0]?.changes).toContainEqual({
			path: "evidence.function shapes_name.doc",
			kind: "changed",
			before: "Returns a borrowed name that is never NULL.",
			after: "Returns a borrowed name that is sometimes NULL.",
		});
		expect(readFileSync(lock, "utf8")).toBe(before);
		accept(directory);
		expect(check(directory).ok).toBe(true);
	});

	it("ignores citation locations and uncited documentation", () => {
		const directory = project();
		const headerPath = path.join(directory, "include/shapes.h");
		const documented = header.replace(
			"const char *shapes_name",
			"// Returns a borrowed name.\nconst char *shapes_name",
		);
		writeFileSync(headerPath, documented);
		writeContract(directory, {
			functions: {
				shapes_name: { evidence: [{ kind: "function", name: "shapes_name" }] },
			},
		});
		accept(directory);
		writeFileSync(
			headerPath,
			`\n\n${documented.replace("int shapes_index", "// Accepts an index.\nint shapes_index")}`,
		);
		const relocated = project();
		cpSync(directory, relocated, { recursive: true });
		expect(check(relocated).ok).toBe(true);
	});

	it("distinguishes typedef and tag evidence and watches member documentation", () => {
		const directory = project();
		const headerPath = path.join(directory, "include/shapes.h");
		const documented = `${header}
// A resource layout.
struct ShapesResource {
  int state; // Resource state.
};
// A resource alias.
typedef struct ShapesResource ShapesResource;
// The index range.
typedef unsigned short ShapesLimit;
`;
		writeFileSync(headerPath, documented);
		writeContract(directory, {
			types: {
				ShapesResource: {
					handle: {},
					evidence: [
						{ kind: "struct", name: "ShapesResource" },
						{ kind: "typedef", name: "ShapesResource" },
					],
				},
				ShapesLimit: { evidence: [{ kind: "typedef", name: "ShapesLimit" }] },
			},
		});
		accept(directory);
		writeFileSync(
			headerPath,
			documented.replace("Resource state.", "Caller-owned resource state."),
		);
		expect(check(directory, [], 1).libraries[0]?.changes).toEqual([
			{
				path: "evidence.struct ShapesResource.members.state",
				kind: "changed",
				before: "Resource state.",
				after: "Caller-owned resource state.",
			},
		]);
	});

	it("checks documentation on a macro even when its value cannot bind", () => {
		const directory = project();
		const headerPath = path.join(directory, "include/shapes.h");
		const documented = `${header}\n// A borrowed callback expression.\n#define SHAPES_CALLBACK shapes_unavailable_symbol\n`;
		writeFileSync(headerPath, documented);
		writeContract(directory, {
			functions: {
				shapes_name: { evidence: [{ kind: "macro", name: "SHAPES_CALLBACK" }] },
			},
		});
		accept(directory);
		writeFileSync(
			headerPath,
			documented.replace("borrowed callback", "retained callback"),
		);
		expect(check(directory, [], 1).libraries[0]?.changes).toContainEqual({
			path: "evidence.macro SHAPES_CALLBACK.doc",
			kind: "changed",
			before: "A borrowed callback expression.",
			after: "A retained callback expression.",
		});
	});

	it.each(["missing", "undocumented"])(
		"preserves the accepted snapshot when cited documentation is %s",
		(condition) => {
			const directory = project();
			const headerPath = path.join(directory, "include/shapes.h");
			writeFileSync(
				headerPath,
				`${header}\n// Releases a name.\nvoid shapes_release(void *value);\n`,
			);
			writeContract(directory, {
				functions: {
					shapes_name: { evidence: [{ kind: "function", name: "shapes_release" }] },
				},
			});
			accept(directory);
			const lock = path.join(directory, "maligator-ffi.lock.json");
			const before = readFileSync(lock, "utf8");
			writeFileSync(
				headerPath,
				condition === "missing"
					? header
					: `${header}\nvoid shapes_release(void *value);\n`,
			);
			for (const args of [[], ["--update"]]) {
				const result = cli(directory, ["check", ...args]);
				expect(result.status).toBe(1);
				expect(result.stderr).toContain("functions.shapes_name.evidence[0]");
				expect(result.stderr).toContain("function shapes_release");
				expect(readFileSync(lock, "utf8")).toBe(before);
			}
		},
	);

	it("rejects malformed evidence references before recording a snapshot", () => {
		const directory = project();
		writeContract(directory, {
			functions: {
				shapes_name: {
					evidence: [
						{
							kind: "function",
							name: "shapes_name",
							// @ts-expect-error -- The CLI must reject unsupported citation fields.
							url: "https://example.invalid",
						},
					],
				},
			},
		});
		const result = cli(directory, ["check", "--update"]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("evidence[0]");
		expect(result.stderr).toContain("url");
		expect(existsSync(path.join(directory, "maligator-ffi.lock.json"))).toBe(false);
	});

	it("updates only the selected library and preserves other target snapshots", () => {
		const directory = project(["shapes", "sketch"]);
		accept(directory);
		const lock = path.join(directory, "maligator-ffi.lock.json");
		const recorded = JSON.parse(readFileSync(lock, "utf8")) as {
			targets: Record<string, unknown>;
		};
		const current = recorded.targets[Object.keys(recorded.targets)[0]!]!;
		recorded.targets["fictional-target"] = current;
		writeFileSync(lock, JSON.stringify(recorded));
		writeFileSync(
			path.join(directory, "include/shapes.h"),
			header.replace("unsigned short", "unsigned int"),
		);
		expect(check(directory, ["shapes", "--update"]).ok).toBe(true);
		expect(check(directory, ["shapes"]).ok).toBe(true);
		expect(check(directory, ["sketch"], 1).libraries[0]?.status).toBe("changed");
		const updated = JSON.parse(readFileSync(lock, "utf8")) as typeof recorded;
		expect(updated.targets["fictional-target"]).toEqual(current);
	});

	it("reports a removed library until an all-library update accepts its removal", () => {
		const directory = project(["shapes", "sketch"]);
		accept(directory);
		writeFileSync(
			path.join(directory, "maligator.build.ts"),
			'export default { ffi: { shapes: { contract: "shapes.ffi.ts" } } };\n',
		);
		expect(check(directory, [], 1).libraries).toContainEqual({
			library: "sketch",
			status: "removed",
			changes: [],
		});
		expect(check(directory, ["shapes"]).ok).toBe(true);
		accept(directory);
		expect(check(directory).libraries.map((entry) => entry.library)).toEqual(["shapes"]);
	});

	it.each(["{", '{"schema":2,"targets":{}}'])(
		"preserves an invalid lockfile rather than overwriting it: %s",
		(contents) => {
			const directory = project();
			const lock = path.join(directory, "maligator-ffi.lock.json");
			writeFileSync(lock, contents);
			const result = cli(directory, ["check", "--update"]);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("FFI lockfile");
			expect(readFileSync(lock, "utf8")).toBe(contents);
		},
	);
});
