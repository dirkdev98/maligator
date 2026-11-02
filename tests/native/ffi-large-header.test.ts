import { execFileSync, spawnSync } from "node:child_process";
import { hash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { visitClangDeclarations } from "../../src/ffi/clang-ast.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
} from "../../src/test-harness.ts";
import { resolvePathExecutable } from "../../src/toolchain.ts";

describe("large C headers", () => {
	it("extracts declarations after an individual clang declaration exceeds the native string limit", () => {
		const directory = mkdtempSync(join(tmpdir(), "mal-ffi-large-header-"));
		try {
			const body = "value += 1; ".repeat(16_384);
			writeFileSync(
				join(directory, "auxiliary.h"),
				`static inline int auxiliary(int value) { ${body}return value; }`,
			);
			writeFileSync(
				join(directory, "large.h"),
				[
					'#include "auxiliary.h"',
					"typedef struct { int value; } LargeValue;",
					"// Read the value.",
					"int large_value(LargeValue value);",
					"// Read another value.",
					"int large_other(int value);",
					"",
				].join("\n"),
			);
			const compiler = process.env.CC ?? "cc";
			const dump = spawnSync(
				compiler,
				[
					"-std=c2x",
					"-fsyntax-only",
					"-w",
					"-Xclang",
					"-ast-dump=json",
					"-x",
					"c",
					join(directory, "large.h"),
				],
				{ maxBuffer: 256 * 1024 * 1024 },
			);
			expect(dump.status, dump.stderr.toString()).toBe(0);
			expect(dump.stdout.byteLength).toBeGreaterThan(16 * 1024 * 1024);
			let largestDeclaration = 0;
			visitClangDeclarations(dump.stdout, (node) => {
				largestDeclaration = Math.max(
					largestDeclaration,
					Buffer.byteLength(JSON.stringify(node)),
				);
			});
			expect(largestDeclaration).toBeGreaterThan(16 * 1024 * 1024);
			const fixture = "tests/fixtures/ffi-extract-native/main.ts";
			const env = { MAL_FFI_HEADER_DIR: directory, MAL_FFI_COMPILER: compiler };
			const expected = execFileSync(process.execPath, [fixture], {
				env: { ...process.env, ...env },
				encoding: "utf8",
				timeout: 60_000,
			});
			const report = JSON.parse(expected) as {
				functions: Array<{ name: string; doc: string; location: { file: string } }>;
			};
			expect(
				Object.fromEntries(report.functions.map((entry) => [entry.name, entry.doc])),
			).toEqual({
				large_value: "Read the value.",
				large_other: "Read another value.",
			});
			expect(
				report.functions.every(
					(entry) => entry.location.file === resolve(directory, "large.h"),
				),
			).toBe(true);
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: "ffi-large-header",
				outDir: directory,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { eval: false, realms: false },
					surface: { node: true },
				}),
			});
			for (const binary of [pair.compiled, pair.interpreted])
				expect(
					runToStdout(binary, { env: { ...env, MAL_GC_VERIFY: "1" }, timeoutMs: 60_000 }),
				).toBe(expected);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 300_000);

	it("preserves large documentation on extraction and cache hits", () => {
		const directory = mkdtempSync(join(tmpdir(), "mal-ffi-large-model-"));
		try {
			const include = join(directory, "include");
			mkdirSync(include);
			const prose = "The caller owns this fictional resource. Grüße🙂".padEnd(1024, ".");
			const documentation = Array.from(
				{ length: 64 },
				(_, index) => `${prose} ${index}`,
			).join("\n");
			const declarations = Array.from(
				{ length: 300 },
				(_, index) => `large_documented_${index}`,
			);
			const comment = `/*\n${documentation
				.split("\n")
				.map((line) => ` * ${line}`)
				.join("\n")}\n */`;
			const header = [
				"typedef struct { int value; } LargeValue;",
				"enum LargeMode { LARGE_FIRST = 1, LARGE_SECOND = 0x100000000ULL };",
				"#define LARGE_BIG 0x100000000ULL",
				...declarations.map((name) => `${comment}\nint ${name}(int value);`),
			].join("\n");
			const headerPath = join(include, "large.h");
			writeFileSync(headerPath, header);
			expect(statSync(headerPath).size).toBeGreaterThan(16 * 1024 * 1024);
			const compiler = resolvePathExecutable(process.env.CC ?? "cc");
			const log = join(directory, "compiler.log");
			const wrapper = join(directory, "cc");
			const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
			writeFileSync(
				wrapper,
				`#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(log)}\nexec ${quote(compiler)} "$@"\n`,
			);
			chmodSync(wrapper, 0o755);
			const fixture = "tests/fixtures/ffi-extract-native/main.ts";
			const env = {
				MAL_FFI_HEADER_DIR: include,
				MAL_FFI_COMPILER: wrapper,
				MAL_FFI_CACHE: "1",
			};
			const expected = execFileSync(process.execPath, [fixture], {
				env: {
					...process.env,
					...env,
					MALIGATOR_CACHE_DIR: join(directory, "node-cache"),
				},
				encoding: "utf8",
				timeout: 60_000,
			});
			const report = JSON.parse(expected) as {
				functions: Array<{ name: string; docLength: number; docHash: string }>;
			};
			expect(report.functions.map(({ name }) => name).sort()).toEqual(
				[...declarations].sort(),
			);
			const documentationHash = hash("sha256", documentation);
			expect(
				report.functions.every(
					(entry) =>
						entry.docLength === documentation.length &&
						entry.docHash === documentationHash,
				),
			).toBe(true);
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: "ffi-large-model",
				outDir: directory,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { eval: false, realms: false },
					surface: { node: true },
				}),
			});
			const cache = join(directory, "native-cache");
			const astDumps = () =>
				readFileSync(log, "utf8")
					.split("\n")
					.filter((line) => line.includes("-ast-dump")).length;
			const before = astDumps();
			const nativeEnv = { ...env, MALIGATOR_CACHE_DIR: cache, MAL_GC_VERIFY: "1" };
			expect(runToStdout(pair.compiled, { env: nativeEnv, timeoutMs: 60_000 })).toBe(
				expected,
			);
			const extracted = astDumps();
			expect(extracted).toBeGreaterThan(before);
			for (const binary of [pair.interpreted, pair.compiled]) {
				expect(runToStdout(binary, { env: nativeEnv, timeoutMs: 60_000 })).toBe(expected);
				expect(astDumps()).toBe(extracted);
			}
			expect(
				readdirSync(cache, { recursive: true, withFileTypes: true }).some(
					(entry) =>
						entry.isFile() &&
						statSync(join(entry.parentPath, entry.name)).size > 16 * 1024 * 1024,
				),
			).toBe(true);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 300_000);
});
