import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	buildNativeProgramImage,
	runToStdout,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(
	path.join(os.tmpdir(), "mal-interpreter-call-cache-p1-item9-"),
);
const expected = ["interpreter-call-cache-p1-item9 PASS"];
const compilerStressEnv = { MAL_GC_STRESS: "1000", MAL_GC_VERIFY: "1" };

describe("bounded interpreter call-site cache", () => {
	let interpreted: string;
	let mixed: string;
	let mismatched: string;

	beforeAll(() => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/interpreter-call-cache-p1-item9.js",
			name: "interpreter-call-cache-p1-item9",
			outDir,
		});
		interpreted = pair.interpreted;
		mixed = pair.compiled;
		let exactCalls = 0;
		let exactConstructs = 0;
		const functions = pair.programImage.runtime.functions.map((fn) => ({
			...fn,
			instructions: fn.instructions.map((instruction) => {
				if (
					(instruction.opcode !== "CALL" && instruction.opcode !== "CONSTRUCT") ||
					instruction.exactFunctionIndex === undefined
				) {
					return instruction;
				}
				if (instruction.opcode === "CALL") exactCalls++;
				else exactConstructs++;
				return {
					...instruction,
					exactFunctionIndex:
						(instruction.exactFunctionIndex + 1) %
						pair.programImage.runtime.functionCount,
				};
			}),
		}));
		if (exactCalls === 0 || exactConstructs === 0) {
			throw new Error("fixture did not lower exact CALL and CONSTRUCT targets");
		}
		mismatched = buildNativeProgramImage(
			{
				...pair.programImage,
				runtime: { ...pair.programImage.runtime, functions },
			},
			{
				name: "interpreter-call-cache-p1-item9-mismatch",
				outDir,
				compiled: false,
			},
		);
	});

	it("preserves direct interpreted calls, eval splices, and fallback semantics", () => {
		assertExactLines(
			runToStdout(interpreted, { env: { MAL_HOST_GC: "1" }, timeoutMs: 60_000 }),
			expected,
		);
	});

	it("falls back from interpreted eval code to compiled callees", () => {
		assertExactLines(
			runToStdout(mixed, { env: { MAL_HOST_GC: "1" }, timeoutMs: 60_000 }),
			expected,
		);
	});

	it("falls back when portable exact-target identities do not match", () => {
		assertExactLines(runToStdout(mismatched, { timeoutMs: 60_000 }), expected);
	});

	it("keeps epoch-guarded identities safe under GC stress", () => {
		assertExactLines(
			runToStdout(interpreted, {
				env: { MAL_HOST_GC: "1", ...compilerStressEnv },
				timeoutMs: 60_000,
			}),
			expected,
		);
	});
});
