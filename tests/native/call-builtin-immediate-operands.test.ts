import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	decodeVmValueOperand,
	encodeVmValueOperand,
} from "../../src/compiler/target/runtime-image.ts";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	buildNativeProgramImage,
	runToStdout,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-builtin-immediates-"));
const expected = ["call-builtin-immediate-operands PASS"];

describe("direct builtin immediate operands", () => {
	let compiled: string;
	let interpreted: string;
	let primitiveReceiverCompiled: string;

	beforeAll(() => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/call-builtin-immediate-operands.js",
			name: "call-builtin-immediate-operands",
			outDir,
			config: resolveBuildConfig({ engine: { primordials: "locked" } }),
		});
		compiled = pair.compiled;
		interpreted = pair.interpreted;

		const calls = pair.programImage.runtime.functions
			.flatMap((fn) => fn.instructions)
			.filter((instruction) => instruction.opcode === "CALL_BUILTIN");
		expect(calls.length).toBeGreaterThan(0);
		expect(
			calls.some(
				(instruction) => decodeVmValueOperand(instruction.thisValue).kind !== "register",
			),
		).toBe(true);
		expect(
			calls.some((instruction) => {
				const kinds = instruction.arguments.map(
					(operand) => decodeVmValueOperand(operand).kind,
				);
				return kinds.includes("register") && kinds.some((kind) => kind !== "register");
			}),
		).toBe(true);

		let objectIsCalls = 0;
		const functions = pair.programImage.runtime.functions.map((fn) => ({
			...fn,
			instructions: fn.instructions.map((instruction) => {
				if (
					instruction.opcode !== "CALL_BUILTIN" ||
					instruction.operation !== "Object.is"
				) {
					return instruction;
				}
				const receiver =
					objectIsCalls++ === 0
						? ({ kind: "undefined" } as const)
						: ({ kind: "null" } as const);
				return {
					...instruction,
					thisValue: encodeVmValueOperand(-1, receiver),
				};
			}),
		}));
		expect(objectIsCalls).toBeGreaterThanOrEqual(2);
		primitiveReceiverCompiled = buildNativeProgramImage(
			{
				...pair.programImage,
				runtime: { ...pair.programImage.runtime, functions },
			},
			{
				name: "call-builtin-immediate-primitive-receivers",
				outDir,
				compiled: true,
				config: resolveBuildConfig({ engine: { primordials: "locked" } }),
			},
		);
	}, 600_000);

	it("preserves allocation and throw behavior in native output", () => {
		for (const binary of [compiled, primitiveReceiverCompiled]) {
			assertExactLines(
				runToStdout(binary, {
					env: { MAL_GC_STRESS: "1", MAL_GC_VERIFY: "1" },
					timeoutMs: 60_000,
				}),
				expected,
			);
		}
	});

	it("preserves allocation and throw behavior in portable output", () => {
		assertExactLines(
			runToStdout(interpreted, {
				env: { MAL_GC_STRESS: "1", MAL_GC_VERIFY: "1" },
				timeoutMs: 60_000,
			}),
			expected,
		);
	});
});
