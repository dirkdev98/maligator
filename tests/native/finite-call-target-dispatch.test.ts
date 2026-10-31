import { execFileSync } from "node:child_process";
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
	let interpretedSets: Array<ReadonlyArray<number>>;

	beforeAll(() => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/finite-call-target-dispatch.js",
			name: "finite-call-target-dispatch",
			outDir,
			// A module stores its function declarations outside the body that writes their properties.
			entryGoal: "script",
		});
		interpreted = pair.interpreted;
		compiled = pair.compiled;
		// Native plans address their own body, which can diverge from the runtime bytecode.
		candidateSets = pair.programImage.native.functions.flatMap((plan) =>
			plan.body.instructions.flatMap((instruction, instructionIndex) => {
				if (
					instruction.opcode !== "CALL" ||
					instruction.guardedFunctionIndices === undefined
				) {
					return [];
				}
				expect(plan.instructions[instructionIndex]).toMatchObject({
					kind: "call",
					guardedFunctionIndices: instruction.guardedFunctionIndices,
				});
				return [instruction.guardedFunctionIndices];
			}),
		);
		interpretedSets = pair.programImage.runtime.functions.flatMap((fn) =>
			fn.instructions.flatMap((instruction) =>
				instruction.opcode === "CALL" && instruction.guardedFunctionIndices !== undefined
					? [instruction.guardedFunctionIndices]
					: [],
			),
		);
	});

	it("lowers a deterministic two-target set into both outputs", () => {
		expect(candidateSets.some((targets) => targets.length === 2)).toBe(true);
		expect(interpretedSets.some((targets) => targets.length === 2)).toBe(true);
		for (const targets of [...candidateSets, ...interpretedSets]) {
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
		for (const binary of [compiled, interpreted]) {
			assertExactLines(
				runToStdout(binary, {
					env: { MAL_HOST_GC: "1", ...STRESS_ENV },
					timeoutMs: 60_000,
				}),
				expected,
			);
		}
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

describe("escaped object literal method calls", () => {
	const fixture = "tests/local/object-literal-method-guard.js";
	let interpreted: string;
	let compiled: string;

	beforeAll(() => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "object-literal-method-guard",
			outDir,
		});
		interpreted = pair.interpreted;
		compiled = pair.compiled;
		const { runtime, native } = pair.programImage;
		const index = runtime.functions.findIndex(
			(fn) =>
				String.fromCharCode(...(runtime.stringConstants[fn.nameStringIndex] ?? [])) ===
				"literalMethodCalls",
		);
		expect(index).toBeGreaterThanOrEqual(0);
		// The initializer's method is a guarded candidate, inlined or called directly.
		expect(
			runtime.functions[index]!.instructions.some(
				(instruction) => instruction.opcode === "GUARD_FUNCTION_INDEX",
			) ||
				native.functions[index]!.instructions.some(
					(instruction) =>
						instruction?.kind === "call" &&
						instruction.guardedFunctionIndices?.length === 1,
				),
		).toBe(true);
	});

	it.each([
		["interpreted", () => interpreted],
		["compiled", () => compiled],
	] as const)(
		"falls back when the escaped field is replaced in %s output",
		(_, binary) => {
			const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
			expect(runToStdout(binary(), { env: { MAL_HOST_GC: "1" } })).toBe(expected);
			expect(runToStdout(binary(), { env: { MAL_HOST_GC: "1", ...STRESS_ENV } })).toBe(
				expected,
			);
		},
	);
});
