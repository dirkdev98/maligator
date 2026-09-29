import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { compileEntrypoint } from "../../src/compiler/pipeline/compile-program.ts";
import { buildNativeProgramImage, runToStdout } from "../../src/test-harness.ts";
import { testProgramImage } from "../helpers/program-image.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-portable-array-length-"));

describe("portable exact Array length", () => {
	let compiled: string;
	let interpreted: string;
	let mismatched: Array<string>;

	beforeAll(() => {
		const config = resolveBuildConfig({ engine: { primordials: "mutable" } });
		const image = compileEntrypoint(
			path.resolve("tests/local/portable-exact-array-length.js"),
			{ buildConfig: config },
		);
		const keepIndex = image.runtime.stringConstants.findIndex(
			(units) => String.fromCharCode(...units) === "keep",
		);
		const lengthIndex = image.runtime.stringConstants.findIndex(
			(units) => String.fromCharCode(...units) === "length",
		);
		let specializedLoads = 0;
		const functions = image.runtime.functions.map((fn) => {
			const fallbackLoad = fn.instructions.find(
				(instruction) =>
					instruction.opcode === "LOAD_PROPERTY_STATIC" &&
					instruction.stringIndex === keepIndex,
			);
			if (fallbackLoad?.opcode !== "LOAD_PROPERTY_STATIC") return fn;
			return {
				...fn,
				instructions: fn.instructions.map((instruction) => {
					if (
						instruction.opcode !== "LOAD_PROPERTY_STATIC" ||
						instruction.stringIndex !== lengthIndex
					) {
						return instruction;
					}
					specializedLoads++;
					return { ...instruction, opcode: "LOAD_PROPERTY_STATIC_ARRAY_LENGTH" as const };
				}),
			};
		});
		if (specializedLoads !== 1) {
			throw new Error(
				`expected one portable exact Array length load, got ${specializedLoads}`,
			);
		}
		const specialized = testProgramImage({ ...image.runtime, functions });
		compiled = buildNativeProgramImage(specialized, {
			name: "portable-exact-array-length",
			outDir,
			config,
			compiled: true,
		});
		interpreted = buildNativeProgramImage(specialized, {
			name: "portable-exact-array-length-ni",
			outDir,
			config,
			compiled: false,
		});
		const mismatch = testProgramImage({
			...image.runtime,
			functions: functions.map((fn) => {
				const fallback = fn.instructions.find(
					(instruction) =>
						instruction.opcode === "LOAD_PROPERTY_STATIC" &&
						instruction.stringIndex === keepIndex,
				);
				if (fallback?.opcode !== "LOAD_PROPERTY_STATIC") return fn;
				return {
					...fn,
					instructions: fn.instructions.map((instruction) =>
						instruction.opcode === "LOAD_PROPERTY_STATIC_ARRAY_LENGTH"
							? { ...instruction, object: fallback.object }
							: instruction,
					),
				};
			}),
		});
		mismatched = [true, false].map((compiled) =>
			buildNativeProgramImage(mismatch, {
				name: `portable-exact-array-length-mismatch-${compiled}`,
				outDir,
				config,
				compiled,
			}),
		);
	}, 600_000);

	it("uses the exact load in native and portable VM output", () => {
		expect(runToStdout(compiled)).toBe("3\n");
		expect(runToStdout(interpreted)).toBe("3\n");
	});

	it("runs the ordinary accessor path when the portable guard misses", () => {
		for (const binary of mismatched) expect(runToStdout(binary)).toBe("9\n");
	});
});
