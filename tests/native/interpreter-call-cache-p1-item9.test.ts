import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	buildNativeProgramImage,
	resolveHarnessExecutionInvocation,
	runToStdout,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(
	path.join(os.tmpdir(), "mal-interpreter-call-cache-p1-item9-"),
);
const expected = ["interpreter-call-cache-p1-item9 PASS"];
const compilerStressEnv = { MAL_GC_STRESS: "1000", MAL_GC_VERIFY: "1" };
const perfEnvironment = { ...process.env, MAL_PERF_STATS: "1" };

describe("bounded interpreter call-site cache", () => {
	let interpreted: string;
	let mixed: string;
	let mismatched: string;

	beforeAll(() => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/interpreter-call-cache-p1-item9.js",
			name: "interpreter-call-cache-p1-item9",
			outDir,
			environment: perfEnvironment,
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
					(instruction.opcode === "CALL" && instruction.exactFunctionIndex === undefined)
				) {
					return instruction;
				}
				if (instruction.opcode === "CALL") exactCalls++;
				else exactConstructs++;
				const target = instruction.exactFunctionIndex;
				return {
					...instruction,
					exactFunctionIndex:
						target === undefined
							? 0
							: (target + 1) % pair.programImage.runtime.functionCount,
				};
			}),
		}));
		if (exactCalls === 0 || exactConstructs === 0) {
			throw new Error(
				"fixture needs an exact call and a construction for stale target hints",
			);
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

	it.each(["direct", "bound"] as const)(
		"attributes in-loop calls and returns for a %s callee",
		(kind) => {
			const { executable, args } = resolveHarnessExecutionInvocation(interpreted);
			const result = spawnSync(executable, args, {
				encoding: "utf-8",
				env: {
					...perfEnvironment,
					MAL_PERF_CONTROL: "1",
					MAL_TEST_INLINE_CALL: kind,
				},
				timeout: 60_000,
			});
			if (result.error !== undefined) throw result.error;
			expect(result.status, result.stderr).toBe(0);
			assertExactLines(result.stdout, expected);
			const line = result.stderr.match(/^\[perf-interpreter-stats\].*$/m)?.[0];
			if (line === undefined)
				throw new Error(`Missing interpreter stats:\n${result.stderr}`);
			for (const name of ["inline_call_entries", "inline_call_returns"]) {
				const count = Number(line.match(new RegExp(` ${name}=(\\d+)\\b`))?.[1]);
				if (kind === "direct") expect(count, name).toBeGreaterThan(0);
				else expect(count, name).toBe(0);
			}
		},
	);

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
