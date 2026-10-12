import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { stripCompactTypes } from "../../src/compiler/frontend/compact-type-strip.ts";
import { parseCompilerCapture } from "../../src/profile-artifact.ts";
import {
	buildBackendPairFromOneProgramImage,
	buildNativeBinaryResult,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/read-accessor-regions.mjs";
const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" }).trim();

function probeCounters(stderr: string): Record<string, number> {
	const line = stderr.match(/^\[perf-probe-reads\].*$/m)?.[0] ?? "";
	return Object.fromEntries(
		[...line.matchAll(/\b(\w+)=(\d+)/g)].map(([, name, value]) => [name!, Number(value)]),
	);
}

describe("admitted class read-accessor regions", () => {
	it("executes the real kernel loop without entering accessors until an indexed admission fails", () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), "mal-kernel-accessors-"));
		try {
			const kernel = readFileSync("src/compiler/core/core-function-kernel.ts", "utf8");
			const callers = readFileSync(
				"src/compiler/core/core-cross-call-transforms.ts",
				"utf8",
			);
			const start = callers.indexOf("function materializeInstructionOperands(");
			const end = callers.indexOf("\nfunction ", start + 1);
			const fixturePath = path.join(directory, "kernel.mjs");
			writeFileSync(
				fixturePath,
				stripCompactTypes(`${kernel}\n${callers.slice(start, end)}
const hole = process.argv[2] === "hole";
const owner = { kernel: new CoreFunctionKernel({
 instructionOperandStart: [0], instructionOperandCount: [2],
 operands: hole ? [7, ,] : [7, 11],
}) };
globalThis.materialize = materializeInstructionOperands;
let count = 0;
for (let round = 0; round < 200; round++) {
 const values = globalThis.materialize(owner, 0);
 if (values[0] !== 7 || (hole ? values[1] !== undefined : values[1] !== 11))
  throw new Error("operand materialization");
 count += values.length;
}
console.log(count);`),
			);
			const built = buildNativeBinaryResult({
				fixture: fixturePath,
				name: "kernel-accessor-execution",
				compiled: true,
				profileEnabled: true,
				nodeEnabled: true,
				environment: { ...process.env, MAL_PERF_STATS: "1" },
				outDir: directory,
			});
			const ablated = buildNativeBinaryResult({
				fixture: fixturePath,
				name: "kernel-accessor-ablation",
				compiled: true,
				profileEnabled: true,
				nodeEnabled: true,
				environment: { ...process.env, MAL_PERF_STATS: "1" },
				coreOptimizationBenchmarkAblation: { family: "class-read-accessors" },
				outDir: directory,
			});
			expect(
				ablated.programImage.native.functions.some((fn) =>
					fn.body.instructions.some((instruction) => instruction.opcode === "PROBE_READ"),
				),
			).toBe(false);
			const control = spawnSync(ablated.binaryPath, ["dense"], {
				env: {
					...process.env,
					MAL_PERF_STATS: "1",
					MAL_PROFILE_CAPTURE: undefined,
					MAL_PROFILE_COMPILER: undefined,
				},
				encoding: "utf8",
				timeout: 30_000,
			});
			expect(control.status, control.stderr).toBe(0);
			expect(control.stdout.trim()).toBe("400");
			const controlCounters = probeCounters(control.stderr);
			console.log(
				JSON.stringify({ mode: "expansion-disabled", counters: controlCounters }),
			);
			const names = built.programImage.runtime.functions.map((fn) => {
				const units = built.programImage.runtime.stringConstants[fn.nameStringIndex];
				return units === undefined ? "" : String.fromCodePoint(...units);
			});
			const accessors = new Set([
				"instructionOperandStart",
				"instructionOperandCount",
				"operandAt",
			]);
			const sites = built.programImage.diagnostics.profileSites ?? [];
			for (const name of accessors)
				expect(
					sites.some((site) => names[site.functionIndex] === name),
					name,
				).toBe(true);
			for (const mode of ["dense", "hole"]) {
				const capture = path.join(directory, `${mode}.bin`);
				const result = spawnSync(built.binaryPath, [mode], {
					env: {
						...process.env,
						MAL_PROFILE_CAPTURE: capture,
						MAL_PROFILE_COMPILER: "1",
						MAL_PROFILE_IDENTITY: "b".repeat(64),
						MAL_PERF_STATS: "1",
					},
					encoding: "utf8",
					timeout: 30_000,
				});
				expect(result.status, result.stderr).toBe(0);
				expect(result.stdout.trim()).toBe("400");
				const events = parseCompilerCapture(readFileSync(`${capture}.compiler`));
				expect(events.bySite.some((site) => site.executions > 0)).toBe(true);
				const executions = (name: string) =>
					sites
						.filter((site) => names[site.functionIndex] === name)
						.reduce((total, site) => total + events.bySite[site.id]!.executions, 0);
				for (const name of accessors)
					if (mode === "hole" && name === "operandAt")
						expect(executions(name)).toBeGreaterThan(0);
					else expect(executions(name), `${mode}: ${name}`).toBe(0);
				const probes = { private: 0, named: 0, indexed: 0 };
				for (const [functionIndex, fn] of built.programImage.native.functions.entries()) {
					if (names[functionIndex] !== "materializeInstructionOperands") continue;
					for (const [index, instruction] of fn.body.instructions.entries()) {
						const siteId = fn.body.profileSiteIds?.[index] ?? -1;
						if (instruction.opcode === "PROBE_READ" && siteId >= 0)
							probes[instruction.readKind] += events.bySite[siteId]!.executions;
					}
				}
				if (mode === "dense") {
					expect(probes.private).toBeGreaterThan(0);
					expect(probes.private).toBeLessThanOrEqual(600);
				}
				const diagnostic = spawnSync(built.binaryPath, [mode], {
					env: {
						...process.env,
						MAL_PERF_STATS: "1",
						MAL_PROFILE_CAPTURE: undefined,
						MAL_PROFILE_COMPILER: undefined,
					},
					encoding: "utf8",
					timeout: 30_000,
				});
				expect(diagnostic.status, diagnostic.stderr).toBe(0);
				expect(diagnostic.stdout.trim()).toBe("400");
				const counters = probeCounters(diagnostic.stderr);
				if (mode === "dense") {
					expect(counters.private_load_attempts).toBeLessThan(
						controlCounters.private_load_attempts!,
					);
					expect(counters.private_hint_hits! + counters.private_searches!).toBe(
						counters.private_attempts,
					);
					expect(counters.private_searches).toBeLessThanOrEqual(1);
					expect(counters.named_cache_hits).toBeGreaterThan(counters.named_searches!);
					expect(counters.named_searches).toBeLessThanOrEqual(8);
					for (const kind of ["private", "named", "indexed"])
						expect(counters[`${kind}_hits`]).toBe(counters[`${kind}_attempts`]);
				} else expect(counters.indexed_hits).toBeLessThan(counters.indexed_attempts!);
				console.log(
					JSON.stringify({
						mode,
						probes,
						counters,
						accessorInstructionExecutions: Object.fromEntries(
							[...accessors].map((name) => [name, executions(name)]),
						),
					}),
				);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 600_000);

	it("preserves overrides, getters, defaults, failures, and retirement in both backends", () => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "read-accessor-regions",
		});
		for (const binary of [pair.compiled, pair.interpreted]) {
			expect(runToStdout(binary).trim()).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV }).trim()).toBe(expected);
		}
	}, 600_000);
});
