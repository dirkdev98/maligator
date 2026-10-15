import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	buildNativeBinary,
	buildNativeBinaryResult,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/guarded-method-devirtualization.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-guarded-method-"));

describe("guarded method devirtualization", () => {
	let expected: string;
	let compiled: string;
	let interpreted: string;
	let guardedRecordCall: boolean;

	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf-8" });
		const built = buildNativeBinaryResult({
			fixture,
			name: "guarded-method",
			compiled: true,
			outDir,
		});
		compiled = built.binaryPath;
		const { runtime, native } = built.programImage;
		const names = runtime.functions.map((fn) =>
			String.fromCharCode(...(runtime.stringConstants[fn.nameStringIndex] ?? [])),
		);
		const caller = native.functions[names.indexOf("invokeRecord")];
		const target = names.indexOf("updateRecord");
		guardedRecordCall =
			target >= 0 &&
			caller !== undefined &&
			caller.instructions.some(
				(plan, ip) =>
					caller.body.instructions[ip]?.opcode === "CALL" &&
					plan?.kind === "call" &&
					plan.guardedFunctionIndices?.includes(target),
			);
		interpreted = buildNativeBinary({
			fixture,
			name: "guarded-method-interpreted",
			compiled: false,
			outDir,
		});
	}, 600_000);

	it("guards invokeRecord's loaded updateRecord closure", () => {
		expect(guardedRecordCall).toBe(true);
	});

	it("preserves polymorphism and all loaded-callee fallbacks", () => {
		expect(runToStdout(compiled)).toBe(expected);
		expect(runToStdout(interpreted)).toBe(expected);
	});

	it("keeps inlined receiver values rooted under GC stress", () => {
		expect(
			runToStdout(compiled, {
				env: { MAL_HOST_GC: "1", ...STRESS_ENV },
				timeoutMs: 60_000,
			}),
		).toBe(expected);
	});
});
