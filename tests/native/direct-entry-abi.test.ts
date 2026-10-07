import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { emitCompiledFunction } from "../../src/compiler/target/render-native-c.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/direct-entry-abi.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-direct-entry-abi-"));

afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("native direct-entry ABI", () => {
	let expected: string;
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "direct-entry-abi",
			config: resolveBuildConfig({}),
			outDir,
			mainFile: HOST_MAIN,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		({ compiled, interpreted } = pair);
		const guardedTransports = pair.programImage.native.functions.flatMap((fn) =>
			fn.directEntries.flatMap((entry) =>
				entry.storage!.callTransports.filter((plan) =>
					entry.callOverrides?.some(
						(call) => call.guarded && call.instructionIp === plan.instructionIp,
					),
				),
			),
		);
		expect(
			guardedTransports.some((plan) =>
				plan.targets.some(
					(target) =>
						target.resultRepresentation === "number" && target.result === "box-number",
				),
			),
		).toBe(true);
		const caller = pair.programImage.native.functions.find(
			(fn) =>
				String.fromCharCode(
					...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
				) === "guardedCaller",
		)!;
		expect(emitCompiledFunction(caller, caller.functionIndex, "", false)).not.toBeNull();
		expect(
			caller.directEntries.some((entry) =>
				entry.storage!.callTransports.some((plan) => {
					const op = caller.body.instructions[plan.instructionIp]!;
					return (
						op.opcode === "CALL" &&
						entry.callOverrides?.some(
							(call) => call.guarded && call.instructionIp === plan.instructionIp,
						) &&
						entry.storage!.privateCallResultIps.includes(plan.instructionIp) &&
						entry.storage!.privateRegisters.includes(op.dst)
					);
				}),
			),
		).toBe(true);
	}, 600_000);

	it("preserves calls, captures, arguments, exceptions, and GC behavior", () => {
		for (const binary of [compiled, interpreted]) {
			expect(runToStdout(binary, { env: { MAL_HOST_GC: "1" } })).toBe(expected);
			expect(
				runToStdout(binary, {
					env: { MAL_HOST_GC: "1", ...STRESS_ENV },
					timeoutMs: 60_000,
				}),
			).toBe(expected);
		}
	});

	it("executes the optimized ABI in the real compiled product", () => {
		const result = spawnSync(compiled, [], {
			encoding: "utf8",
			env: { ...process.env, MAL_PERF_STATS: "1" },
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(result.stdout).toBe(expected);
		const line = result.stderr
			.split("\n")
			.find((candidate) => candidate.startsWith("[perf-call-cache-stats]"));
		expect(line).toBeDefined();
		const hits = Number(line?.match(/direct_entry_hits=([0-9]+)/)?.[1] ?? 0);
		expect(hits).toBeGreaterThan(0);
	});
});
