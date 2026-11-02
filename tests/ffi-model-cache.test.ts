import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planBindings } from "../src/ffi/binding-plan.ts";
import { extractCModel } from "../src/ffi/c-extract.ts";
import type { CExtractionInput } from "../src/ffi/c-extract.ts";
import { generateDeclarations } from "../src/ffi/declarations.ts";
import { FfiSourceChangedError } from "../src/ffi/ffi-error.ts";
import { loadCModel } from "../src/ffi/model-cache.ts";
import { resolvePathExecutable } from "../src/toolchain.ts";

const projects: Array<string> = [];
function project(): string {
	const directory = mkdtempSync(path.join(os.tmpdir(), "mal-header-cache-"));
	projects.push(directory);
	return directory;
}
function input(directory: string, headers = ["cache.h"]): CExtractionInput {
	const requested = process.env.CC ?? "clang";
	const compiler = path.isAbsolute(requested)
		? requested
		: resolvePathExecutable(requested);
	const version = spawnSync(compiler, ["--version"], {
		encoding: "utf8",
		timeout: 15_000,
	});
	expect(version.status, version.stderr).toBe(0);
	return {
		compiler: {
			path: compiler,
			version: version.stdout.split("\n")[0]!,
		},
		environment: process.env,
		headers,
		compileArguments: ["-I", directory],
	};
}
function declarations(request: CExtractionInput): string {
	return [
		...generateDeclarations([
			{
				name: "cache",
				plan: planBindings(loadCModel(request), { types: {}, functions: {} }),
			},
		]),
	].join("");
}
function quote(value: string): string {
	return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
afterEach(() => {
	for (const directory of projects.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("preprocessed C model cache", () => {
	it("retains native layouts for packed, anonymous, and bit-field records", () => {
		const directory = project();
		writeFileSync(
			path.join(directory, "cache.h"),
			`
static inline int local(void) { struct Public { double other; }; return sizeof(struct Public); }
struct Public { char marker; int value; };
typedef struct __attribute__((packed)) {
  char marker;
  unsigned first:3;
  unsigned :0;
  unsigned second:5;
  struct { char value; } nested;
} Packed;
struct Opaque;
#define DECLARE_RECORD(name) typedef struct { char value; } name
DECLARE_RECORD(MacroRecord);
`,
		);
		const request = input(directory);
		const model = extractCModel(request);
		expect(model.records.get("Public")?.layout).toEqual({
			sizeBits: 64,
			alignmentBits: 32,
			fieldOffsetsBits: [0, 32],
		});
		const packed = model.records.get("Packed");
		expect(packed?.layout).toEqual({
			sizeBits: 48,
			alignmentBits: 8,
			fieldOffsetsBits: [0, 8, 32, 32, 40],
		});
		expect(packed?.attributes).toContain("Packed");
		const nested = packed?.fields.at(-1)?.type;
		expect(nested?.kind).toBe("record");
		if (nested?.kind === "record")
			expect(model.records.get(nested.name)?.layout).toEqual({
				sizeBits: 8,
				alignmentBits: 8,
				fieldOffsetsBits: [0],
			});
		expect(model.records.get("Opaque")?.layout).toBeUndefined();
		expect(model.records.get("MacroRecord")?.layout).toEqual({
			sizeBits: 8,
			alignmentBits: 8,
			fieldOffsetsBits: [0],
		});
	});

	it("refreshes layout metadata after a packing change and retains it on cache hits", () => {
		const directory = project();
		const header = path.join(directory, "cache.h");
		const declaration = "struct Public { char marker; int value; };\n";
		writeFileSync(header, declaration);
		const request = input(directory);
		const before = loadCModel(request).records.get("Public")?.layout;
		expect(before).toEqual({
			sizeBits: 64,
			alignmentBits: 32,
			fieldOffsetsBits: [0, 32],
		});
		expect(loadCModel(request).records.get("Public")?.layout).toEqual(before);
		writeFileSync(header, `#pragma pack(push, 1)\n${declaration}#pragma pack(pop)\n`);
		const after = loadCModel(request).records.get("Public")?.layout;
		expect(after).toEqual({ sizeBits: 40, alignmentBits: 8, fieldOffsetsBits: [0, 8] });
		expect(loadCModel(request).records.get("Public")?.layout).toEqual(after);
	});

	it("keeps compiler scratch outside the guarded input directories", () => {
		const directory = project();
		const previous = process.env.TMPDIR;
		try {
			process.env.TMPDIR = directory;
			writeFileSync(path.join(directory, "cache.h"), "int cache_value(int value);\n");
			expect(declarations(input(directory))).toContain(
				"export function cache_value(value: number): number;",
			);
		} finally {
			if (previous === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = previous;
		}
	});
	it("ignores an unrelated symlink loop in a header search tree", () => {
		const directory = project();
		symlinkSync("loop", path.join(directory, "loop"));
		writeFileSync(path.join(directory, "cache.h"), "int cache_value(int value);\n");
		expect(declarations(input(directory))).toContain(
			"export function cache_value(value: number): number;",
		);
	});
	it("extracts headers when the artifact cache is inside the include root", () => {
		const directory = project();
		const previous = process.env.MALIGATOR_CACHE_DIR;
		try {
			process.env.MALIGATOR_CACHE_DIR = path.join(directory, ".cache");
			writeFileSync(path.join(directory, "cache.h"), "int cache_value(int value);\n");
			expect(declarations(input(directory))).toContain(
				"export function cache_value(value: number): number;",
			);
			expect(declarations(input(directory))).toContain(
				"export function cache_value(value: number): number;",
			);
		} finally {
			if (previous === undefined) delete process.env.MALIGATOR_CACHE_DIR;
			else process.env.MALIGATOR_CACHE_DIR = previous;
		}
	});
	it("preserves counter expansion across conditional directives", () => {
		const directory = project();
		writeFileSync(
			path.join(directory, "cache.h"),
			"#if __COUNTER__ == 0\nint cache_value(int value);\n#endif\nenum CacheIndex { CACHE_INDEX = __COUNTER__ };\n",
		);
		expect(
			loadCModel(input(directory))
				.enums.get("CacheIndex")
				?.constants.find((entry) => entry.name === "CACHE_INDEX")?.value,
		).toBe(1n);
	});
	it("applies forced headers once during analysis", () => {
		const directory = project();
		const forced = path.join(directory, "forced.h");
		writeFileSync(forced, "typedef struct Extra { int value; } Extra;\n");
		writeFileSync(path.join(directory, "cache.h"), "Extra cache_value(Extra value);\n");
		const request = input(directory);
		expect(
			loadCModel({
				...request,
				compileArguments: [...request.compileArguments, "-include", forced],
			}).functions.map((entry) => entry.name),
		).toContain("cache_value");
	});
	it("preserves trailing documentation after macro expansion and inline comments", () => {
		const directory = project();
		writeFileSync(
			path.join(directory, "cache.h"),
			'#define CACHE_API __attribute__((visibility("default")))\nCACHE_API int /* argument */ cache_value(int value); // Value documentation.\n',
		);
		expect(
			loadCModel(input(directory))
				.functions.find((entry) => entry.name === "cache_value")
				?.doc?.chunks.join(""),
		).toBe("Value documentation.");
	});
	it("reads generated headers whose logical source is not installed", () => {
		const directory = project();
		writeFileSync(
			path.join(directory, "cache.h"),
			'#line 1 "schema.idl"\nint cache_value(int value);\n',
		);
		expect(declarations(input(directory))).toContain(
			"export function cache_value(value: number): number;",
		);
	});
	it("preserves parser flags while evaluating frozen probes", () => {
		const directory = project();
		writeFileSync(path.join(directory, "cache.h"), "int cache_value(char value);\n");
		const request = input(directory);
		expect(
			loadCModel({
				...request,
				compileArguments: [...request.compileArguments, "-funsigned-char"],
			}).target.charSigned,
		).toBe(false);
		expect(
			loadCModel({
				...request,
				compileArguments: [...request.compileArguments, "-fsigned-char"],
			}).target.charSigned,
		).toBe(true);
	});
	it("rejects an optional header created and removed during AST compilation", () => {
		const directory = project();
		const request = input(directory);
		const optional = path.join(directory, "optional.h");
		const wrapper = path.join(directory, "clang");
		const trigger = path.join(directory, "mutate-once");
		writeFileSync(trigger, "armed");
		writeFileSync(
			path.join(directory, "cache.h"),
			'#if __has_include("optional.h")\nlong long cache_value(long long value);\n#else\nint cache_value(int value);\n#endif\n',
		);
		writeFileSync(
			wrapper,
			`#!/bin/sh\ncase " $* " in *" -ast-dump=json "*)\nif test "$(cat ${quote(trigger)})" = armed; then\nprintf done > ${quote(trigger)}\ntouch ${quote(optional)}\n${quote(request.compiler.path)} "$@"\nstatus=$?\nrm ${quote(optional)}\nexit "$status"\nfi;;\nesac\nexec ${quote(request.compiler.path)} "$@"\n`,
		);
		chmodSync(wrapper, 0o755);
		const transient = { ...request, compiler: { ...request.compiler, path: wrapper } };
		expect(() => loadCModel(transient)).toThrow(FfiSourceChangedError);
		expect(declarations(transient)).toContain(
			"export function cache_value(value: number): number;",
		);
		expect(declarations(transient)).toContain(
			"export function cache_value(value: number): number;",
		);
	});
	it("resolves a newly shadowed nested header before reusing declarations", () => {
		const directory = project();
		const early = path.join(directory, "early");
		const late = path.join(directory, "late");
		for (const root of [early, late])
			mkdirSync(path.join(root, "pkg"), { recursive: true });
		writeFileSync(path.join(late, "pkg/cache.h"), "int cache_value(int value);\n");
		const request = {
			...input(directory, ["pkg/cache.h"]),
			compileArguments: ["-I", early, "-I", late],
		};
		expect(declarations(request)).toContain(
			"export function cache_value(value: number): number;",
		);
		writeFileSync(
			path.join(early, "pkg/cache.h"),
			"long long cache_value(long long value);\n",
		);
		expect(declarations(request)).toContain(
			"export function cache_value(value: bigint): bigint;",
		);
	});
	it("observes a previously absent conditional include", () => {
		const directory = project();
		writeFileSync(
			path.join(directory, "cache.h"),
			'#if __has_include("optional.h")\nlong long cache_value(long long value);\n#else\nint cache_value(int value);\n#endif\n',
		);
		const request = input(directory);
		expect(declarations(request)).toContain(
			"export function cache_value(value: number): number;",
		);
		writeFileSync(path.join(directory, "optional.h"), "");
		expect(declarations(request)).toContain(
			"export function cache_value(value: bigint): bigint;",
		);
	});
	it("rejects a header edited after AST extraction instead of caching mixed revisions", () => {
		const directory = project();
		const header = path.join(directory, "cache.h");
		const trigger = path.join(directory, "change-header");
		const wrapper = path.join(directory, "clang");
		const request = input(directory);
		writeFileSync(header, "int cache_value(int value);\n");
		writeFileSync(trigger, "");
		writeFileSync(
			wrapper,
			`#!/bin/sh\n${quote(request.compiler.path)} "$@"\nstatus=$?\ncase " $* " in *" -ast-dump=json "*)\nif test -f ${quote(trigger)}; then\nrm ${quote(trigger)}\nprintf '%s\\n' 'long long cache_value(long long value);' > ${quote(header)}\nfi;; esac\nexit "$status"\n`,
		);
		chmodSync(wrapper, 0o755);
		const changing = { ...request, compiler: { ...request.compiler, path: wrapper } };
		expect(() => loadCModel(changing)).toThrow(FfiSourceChangedError);
		expect(declarations(changing)).toContain(
			"export function cache_value(value: bigint): bigint;",
		);
		expect(declarations(changing)).toContain(
			"export function cache_value(value: bigint): bigint;",
		);
	});
	it("rejects an optional header created during analysis", () => {
		const directory = project();
		const request = input(directory);
		const optional = path.join(directory, "optional.h");
		const trigger = path.join(directory, "change-includes");
		const wrapper = path.join(directory, "clang");
		writeFileSync(
			path.join(directory, "cache.h"),
			'#if __has_include("optional.h")\nlong long cache_value(long long value);\n#else\nint cache_value(int value);\n#endif\n',
		);
		writeFileSync(trigger, "");
		writeFileSync(
			wrapper,
			`#!/bin/sh\ncase " $* " in *" -ast-dump=json "*)\nif test -f ${quote(trigger)}; then\nrm ${quote(trigger)}\ntouch ${quote(optional)}\nfi;; esac\nexec ${quote(request.compiler.path)} "$@"\n`,
		);
		chmodSync(wrapper, 0o755);
		const changing = { ...request, compiler: { ...request.compiler, path: wrapper } };
		expect(() => loadCModel(changing)).toThrow(FfiSourceChangedError);
		expect(declarations(changing)).toContain(
			"export function cache_value(value: bigint): bigint;",
		);
		rmSync(optional);
		expect(declarations(changing)).toContain(
			"export function cache_value(value: number): number;",
		);
	});
	it("re-evaluates temporal macros despite diagnostic suppression", () => {
		const directory = project();
		const request = input(directory);
		const wrapper = path.join(directory, "clang");
		const clock = path.join(directory, "clock");
		const trigger = path.join(directory, "clock-drift");
		writeFileSync(trigger, "armed");
		writeFileSync(clock, '"01:02:03"');
		writeFileSync(
			path.join(directory, "cache.h"),
			'#pragma clang diagnostic ignored "-Wdate-time"\nstatic const char cache_time[] = __TIME__;\n#define JOIN_INNER(a,b) a##b\n#define JOIN(a,b) JOIN_INNER(a,b)\n#define CACHE_CLOCK JOIN(__TI, ME__)\n',
		);
		writeFileSync(
			wrapper,
			`#!/bin/sh\nclock=$(cat ${quote(clock)})\n${quote(request.compiler.path)} "-D__TIME__=$clock" "$@"\nstatus=$?\ncase " $* " in *" -ast-dump=json "*)\nif test "$(cat ${quote(trigger)})" = armed; then\nprintf done > ${quote(trigger)}\nprintf '%s' '"04:05:06"' > ${quote(clock)}\nfi;; esac\nexit "$status"\n`,
		);
		chmodSync(wrapper, 0o755);
		const temporal = { ...request, compiler: { ...request.compiler, path: wrapper } };
		const first = loadCModel(temporal).macros.find(
			(macro) => macro.name === "CACHE_CLOCK",
		);
		const second = loadCModel(temporal).macros.find(
			(macro) => macro.name === "CACHE_CLOCK",
		);
		expect(first?.contextual).toBe(true);
		expect(second?.contextual).toBe(true);
		expect(first?.value).toBeUndefined();
		expect(second?.value).toBeUndefined();
		expect(second?.expansion).toBe(first?.expansion);
	});
	it("does not retain a probe path as a context-dependent macro value", () => {
		const directory = project();
		writeFileSync(path.join(directory, "cache.h"), "#define CACHE_FILE __FILE__\n");
		const request = input(directory);
		const macro = () =>
			loadCModel(request).macros.find((macro) => macro.name === "CACHE_FILE");
		const first = macro();
		expect(first?.contextual).toBe(true);
		expect(first?.value).toBeUndefined();
		expect(macro()).toEqual(first);
	});
	it("reports opened headers when preprocessing fails", () => {
		const directory = project();
		const header = path.join(directory, "cache.h");
		writeFileSync(header, '#include "missing.h"\n');
		const discovered = new Set<string>();
		expect(() =>
			extractCModel({
				...input(directory),
				onDependencies(files) {
					for (const file of files) discovered.add(file);
				},
			}),
		).toThrow("cannot preprocess");
		expect(discovered.has(header)).toBe(true);
	});
});
