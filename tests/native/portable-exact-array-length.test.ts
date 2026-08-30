import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	buildNativeProgramImage,
	runToStdout,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-portable-array-length-"));

describe("portable exact Array length", () => {
	let compiled: string;
	let interpreted: string;
	let mismatched: string;

	beforeAll(() => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/portable-exact-array-length.js",
			name: "portable-exact-array-length",
			outDir,
		});
		compiled = pair.compiled;
		interpreted = pair.interpreted;
		let specializedLoads = 0;
		const functions = pair.programImage.runtime.functions.map((fn) => {
			const keepIndex = pair.programImage.runtime.stringConstants.findIndex(
				(units) => String.fromCharCode(...units) === "keep",
			);
			const fallbackLoad = fn.instructions.find(
				(instruction) =>
					instruction.opcode === "LOAD_PROPERTY_STATIC" &&
					instruction.stringIndex === keepIndex,
			);
			if (fallbackLoad?.opcode !== "LOAD_PROPERTY_STATIC") return fn;
			return {
				...fn,
				instructions: fn.instructions.map((instruction) => {
					if (instruction.opcode !== "LOAD_PROPERTY_STATIC_ARRAY_LENGTH") {
						return instruction;
					}
					specializedLoads++;
					return { ...instruction, object: fallbackLoad.object };
				}),
			};
		});
		if (specializedLoads !== 1) {
			throw new Error(
				`expected one portable exact Array length load, got ${specializedLoads}`,
			);
		}
		mismatched = buildNativeProgramImage(
			{
				...pair.programImage,
				runtime: { ...pair.programImage.runtime, functions },
			},
			{
				name: "portable-exact-array-length-mismatch",
				outDir,
				compiled: false,
			},
		);
	}, 600_000);

	it("uses the exact load in native and portable VM output", () => {
		expect(runToStdout(compiled)).toBe("3\n");
		expect(runToStdout(interpreted)).toBe("3\n");
	});

	it("runs the ordinary accessor path when the portable guard misses", () => {
		expect(runToStdout(mismatched)).toBe("9\n");
	});
});
