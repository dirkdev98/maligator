import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

describe("conditional own-slot call effects", () => {
	it.each(["production", "separate calls"] as const)(
		"preserves slot effects and observations under GC stress with %s",
		(mode) => {
			const outDir = mkdtempSync(join(tmpdir(), "mal-own-slot-call-effects-"));
			try {
				const { compiled, interpreted, programImage } =
					buildBackendPairFromOneProgramImage({
						fixture: "tests/local/own-slot-call-effects.js",
						name: "own-slot-call-effects",
						mainFile: HOST_MAIN,
						outDir,
						config: resolveBuildConfig({
							engine: { primordials: "locked", eval: false, realms: false },
						}),
						...(mode === "separate calls"
							? {
									coreOptimizationBenchmarkAblation: {
										family: "inlining-cross-call" as const,
									},
								}
							: {}),
					});
				if (mode === "separate calls") {
					const name = (index: number) =>
						String.fromCharCode(...(programImage.runtime.stringConstants[index] ?? []));
					const caller = programImage.native.functions.find(
						(fn) => name(fn.body.nameStringIndex) === "untouched",
					)!;
					expect(caller).toBeDefined();
					expect(
						caller.body.instructions.some((instruction) => instruction.opcode === "CALL"),
					).toBe(true);
					expect(
						caller.body.instructions.some(
							(instruction) =>
								instruction.opcode === "LOAD_PROPERTY_STATIC" &&
								name(instruction.stringIndex) === "x",
						),
					).toBe(false);
				}
				for (const binary of [compiled, interpreted])
					assertExactLines(
						runToStdout(binary, { env: { MAL_HOST_GC: "1", ...STRESS_ENV } }),
						["own-slot-call-effects PASS"],
					);
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);
});
