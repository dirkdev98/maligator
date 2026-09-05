import { mkdtempSync, writeFileSync } from "node:fs";
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

describe("open singleton script call targets", () => {
	let interpreted: string;
	let compiled: string;

	beforeAll(() => {
		const fixture = path.join(outDir, "singleton.js");
		// Exceed the inline budget so the late call specialization owns the mismatch.
		writeFileSync(
			fixture,
			`let calls = 0;
			function add(value) {
				calls++;
				${"value += 1;".repeat(300)}
				return this.bias + value + arguments.length;
			}
			function holder() {}
			holder.bias = 10;
			holder.run = add;
			function invoke(value) {
				let result = 0;
				for (let index = 0; index < 3; index++) result += holder.run(value);
				return result;
			}
			if (invoke(5) !== 948) throw new Error("receiver or arguments changed");
			holder.run = null;
			let threw = false;
			try { invoke(-5); } catch (error) { threw = error instanceof TypeError; }
			if (!threw || calls !== 3) throw new Error("non-callable target entered script");
			console.log("singleton-call-target PASS");`,
		);
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "singleton-call-target",
			outDir,
		});
		interpreted = pair.interpreted;
		compiled = pair.compiled;
		expect(
			pair.programImage.native.functions.some((fn) =>
				fn.instructions.some(
					(instruction) =>
						instruction?.kind === "call" &&
						instruction.guardedFunctionIndices?.length === 1 &&
						instruction.directFunctionIndex === undefined,
				),
			),
		).toBe(true);
	});

	it.each([
		["interpreted", () => interpreted],
		["compiled", () => compiled],
	] as const)("preserves a non-callable replacement in %s output", (_, binary) => {
		assertExactLines(runToStdout(binary()), ["singleton-call-target PASS"]);
		assertExactLines(runToStdout(binary(), { env: STRESS_ENV }), [
			"singleton-call-target PASS",
		]);
	});
});
