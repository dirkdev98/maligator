import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../../src/compiler/target/compiler-artifact-codec.ts";
import { lowerNativeStorage } from "../../src/compiler/target/lower-native-storage.ts";
import {
	buildBackendPairFromOneProgramImage,
	buildNativeProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

describe("proven boxed String comparisons", () => {
	const fixture = "tests/local/native-proven-string-comparisons.js";
	const config = resolveBuildConfig({ engine: { primordials: "locked" } });
	const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-proven-string-compare-"));
	afterAll(() => rmSync(outDir, { recursive: true, force: true }));
	let compiled: string;
	let interpreted: string;
	let expected: string;
	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			config,
			name: "proven-string-original",
			mainFile: HOST_MAIN,
			outDir,
		});
		interpreted = pair.interpreted;
		let comparisons = 0;
		const image = lowerNativeStorage({
			...pair.programImage,
			native: {
				...pair.programImage.native,
				functions: pair.programImage.native.functions.map((fn) => {
					const name = String.fromCharCode(
						...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
					);
					if (!name.startsWith("boxed")) return fn;
					expect(fn.directEntries).toHaveLength(0);
					const op = fn.body.instructions.find((op) => op.opcode === "BINARY");
					if (op?.opcode !== "BINARY") throw new Error("Missing String comparison");
					const ip = fn.body.instructions.indexOf(op);
					expect(fn.instructions[ip]).toMatchObject({
						kind: "exact-operator-input-kinds",
						inputKindMasks: [16, 16],
					});
					comparisons++;
					return {
						...fn,
						registerRepresentations: fn.registerRepresentations.map((rep, local) =>
							local === op.left || local === op.right || local === op.dst ? "boxed" : rep,
						),
					};
				}),
			},
		});
		expect(comparisons).toBe(8);
		compiled = buildNativeProgramImage(
			deserializeCompilerArtifact(serializeCompilerArtifact(image)),
			{
				config,
				name: "proven-string-boxed",
				mainFile: HOST_MAIN,
				outDir,
				compiled: true,
			},
		);
	}, 600_000);

	it("preserves UTF-16 equality, ordering, operand effects and roots across collection", () => {
		for (const binary of [compiled, interpreted])
			for (const stress of [{}, STRESS_ENV])
				expect(
					runToStdout(binary, {
						env: { ...stress, MAL_HOST_GC: "1" },
						timeoutMs: 60_000,
					}),
				).toBe(expected);
	});
});
