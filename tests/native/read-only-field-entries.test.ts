import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { emitCompiledFunction } from "../../src/compiler/target/render-native-c.ts";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
	HOST_MAIN,
} from "../../src/test-harness.ts";

describe("read-only parameter field entries", () => {
	it.each(["locked", "mutable"] as const)(
		"preserves object observation and overridden methods with %s primordials under GC stress",
		(primordials) => {
			const outDir = mkdtempSync(join(tmpdir(), "mal-read-only-fields-"));
			try {
				const { compiled, interpreted, programImage } =
					buildBackendPairFromOneProgramImage({
						fixture: "tests/local/read-only-field-entries.js",
						name: "read-only-field-entries",
						mainFile: HOST_MAIN,
						config: resolveBuildConfig({
							engine: {
								primordials,
								eval: primordials === "mutable",
								realms: primordials === "mutable",
							},
						}),
						outDir,
					});
				expect(
					programImage.native.functions.flatMap((fn) => fn.fieldCalls ?? []).length,
				).toBeGreaterThan(0);
				expect(
					programImage.native.functions.some((fn) =>
						fn.fieldCalls?.some((site) => {
							const allocation = fn.body.instructions[site.allocationIp]!;
							return (
								allocation.opcode === "CREATE_OBJECT_SHAPED" && allocation.count === 4
							);
						}),
					),
				).toBe(true);
				const name = (index: number) =>
					String.fromCharCode(...(programImage.runtime.stringConstants[index] ?? []));
				const mixedCaller = programImage.native.functions.find(
					(fn) => name(fn.body.nameStringIndex) === "mixedDrive",
				)!;
				expect(mixedCaller).toBeDefined();
				expect(mixedCaller.fieldCalls).toHaveLength(1);
				for (const selected of mixedCaller.fieldCalls![0]!.entries) {
					const target = programImage.native.functions[selected.functionIndex]!;
					expect(name(target.body.nameStringIndex)).toBe("format");
					const entry = target.directEntries[selected.entryId]!;
					expect(entry.fieldParameters!.representations).toEqual([
						"boxed",
						"boolean",
						"string",
						"number",
					]);
					const emitted = emitCompiledFunction(
						target,
						selected.functionIndex,
						"",
						false,
					)!;
					expect(
						emitted.directEntries.some((entry) => entry.id === selected.entryId),
					).toBe(true);
				}
				for (const binary of [compiled, interpreted])
					assertExactLines(
						runToStdout(binary, { env: { MAL_HOST_GC: "1", ...STRESS_ENV } }),
						["read-only-field-entries PASS"],
					);
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);
});
