import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-finite-call-target-dispatch-"));
const expected = ["finite-call-target-dispatch PASS"];

describe("finite script call-target dispatch", () => {
	let interpreted: string;
	let compiled: string;
	let candidateSets: Array<ReadonlyArray<number>>;

	beforeAll(() => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/finite-call-target-dispatch.js",
			name: "finite-call-target-dispatch",
			outDir,
		});
		interpreted = pair.interpreted;
		compiled = pair.compiled;
		candidateSets = pair.programImage.runtime.functions.flatMap((fn, functionIndex) =>
			fn.instructions.flatMap((instruction, instructionIndex) => {
				if (
					instruction.opcode !== "CALL" ||
					instruction.guardedFunctionIndices === undefined
				) {
					return [];
				}
				expect(
					pair.programImage.native.functions[functionIndex]!.instructions[
						instructionIndex
					],
				).toMatchObject({
					kind: "call",
					guardedFunctionIndices: instruction.guardedFunctionIndices,
				});
				return [instruction.guardedFunctionIndices];
			}),
		);
	});

	it("lowers a deterministic two-target set into both outputs", () => {
		expect(candidateSets.some((targets) => targets.length === 2)).toBe(true);
		for (const targets of candidateSets) {
			expect(targets).toEqual(
				[...new Set(targets)].toSorted((left, right) => left - right),
			);
		}
	});

	it.each([
		["interpreted", () => interpreted],
		["compiled", () => compiled],
	] as const)(
		"preserves candidate hits, alternate hits, throws, and fallback in %s output",
		(_, binary) => {
			assertExactLines(runToStdout(binary(), { env: { MAL_HOST_GC: "1" } }), expected);
		},
	);

	it("keeps guarded identities and arguments live across collection", () => {
		assertExactLines(
			runToStdout(interpreted, {
				env: { MAL_HOST_GC: "1", ...STRESS_ENV },
				timeoutMs: 60_000,
			}),
			expected,
		);
	});
});
