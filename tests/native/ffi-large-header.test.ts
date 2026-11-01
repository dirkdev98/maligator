import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
} from "../../src/test-harness.ts";

describe("large C headers", () => {
	it("extracts declarations when clang's aggregate AST exceeds the native string limit", () => {
		const directory = mkdtempSync(join(tmpdir(), "mal-ffi-large-header-"));
		try {
			const body = "value += 1; ".repeat(32);
			writeFileSync(
				join(directory, "auxiliary.h"),
				Array.from(
					{ length: 256 },
					(_, index) =>
						`static inline int auxiliary_${index}(int value) { ${body}return value; }`,
				).join("\n"),
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
});
