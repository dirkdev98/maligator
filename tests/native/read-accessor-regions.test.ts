import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { stripCompactTypes } from "../../src/compiler/frontend/compact-type-strip.ts";
import { parseCompilerCapture } from "../../src/profile-artifact.ts";
import {
	buildBackendPairFromOneProgramImage,
	buildNativeBinary,
	buildNativeBinaryResult,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
import { kernelMaterializerSource } from "../helpers/read-accessor-kernel.ts";

const fixture = "tests/local/read-accessor-regions.mjs";
const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" }).trim();

function probeCounters(stderr: string, family = "probe-reads"): Record<string, number> {
	const line = stderr.match(new RegExp(`^\\[perf-${family}\\].*$`, "m"))?.[0] ?? "";
	return Object.fromEntries(
		[...line.matchAll(/\b(\w+)=(\d+)/g)].map(([, name, value]) => [name!, Number(value)]),
	);
}

describe("admitted class read-accessor regions", () => {
	it("invalidates before the native-frame gate and permanently declines a saturated epoch", () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), "mal-accessor-epoch-"));
		try {
			const binary = buildNativeBinary({
				fixture: "tests/local/fibertest_stub.js",
				name: "read-accessor-service-epoch",
				mainFile: "tests/fixtures/read-accessor-service-epoch/main.c",
				outDir: directory,
			});
			expect(runToStdout(binary)).toBe("read-accessor-service-epoch PASS\n");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("keeps real materializer prefix discovery constant as element counts grow", () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), "mal-loop-prefix-scaling-"));
		try {
			const fixturePath = path.join(directory, "scaling.mjs");
			writeFileSync(
				fixturePath,
				`${kernelMaterializerSource(["materializeInstructionOperands", "materializeInstructionResults", "materializeTerminatorEdge"])}
const count = Number(process.argv[2]);
const kind = process.argv[3];
const hole = process.argv[4] === "hole";
const source = Array.from({ length: count }, (_, index) => index + 7);
if (hole && count > 1) delete source[1];
const owner = { kernel: new CoreFunctionKernel({
 instructionOperandStart: [0], instructionOperandCount: [count], operands: source,
 instructionResultStart: [0], instructionResultCount: [count], results: source,
 terminatorEdgeArgumentStart: [0], terminatorEdgeArgumentCount: [count], terminatorEdgeBlock: [7],
}) };
globalThis.materialize = kind === "operands" ? materializeInstructionOperands : kind === "results" ? materializeInstructionResults : materializeTerminatorEdge;
const materialized = globalThis.materialize(owner, 0);
const output = kind === "edge" ? materialized.arguments : materialized;
let sum = 0;
for (let index = 0; index < output.length; index++) sum += output[index] ?? 0;
console.log(JSON.stringify({ count: output.length, sum }));`,
			);
			const config = resolveBuildConfig({
				engine: { primordials: "locked" },
				surface: { node: true },
			});
			const built = buildNativeBinaryResult({
				fixture: fixturePath,
				name: "loop-prefix-scaling",
				compiled: true,
				profileEnabled: true,
				nodeEnabled: true,
				config,
				environment: { ...process.env, MAL_PERF_STATS: "1" },
				outDir: directory,
			});
			const names = built.programImage.runtime.functions.map((fn) =>
				String.fromCodePoint(
					...(built.programImage.runtime.stringConstants[fn.nameStringIndex] ?? []),
				),
			);
			const sites = built.programImage.profiling?.sites ?? [];
			for (const kind of ["operands", "results", "edge"]) {
				const name =
					kind === "operands"
						? "materializeInstructionOperands"
						: kind === "results"
							? "materializeInstructionResults"
							: "materializeTerminatorEdge";
				const accessor = kind === "results" ? "resultAt" : "operandAt";
				const readArray = kind === "edge" ? "operands" : kind;
				let denseDiscovery:
					| { private: number; kernel: number; array: number; method: number }
					| undefined;
				for (const count of [0, 1, 2, 8, 32]) {
					const capture = path.join(directory, `${kind}-${count}.bin`);
					const result = spawnSync(built.binaryPath, [String(count), kind, "dense"], {
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
					const expected = execFileSync(
						process.execPath,
						[fixturePath, String(count), kind, "dense"],
						{ encoding: "utf8" },
					).trim();
					expect(result.status, result.stderr).toBe(0);
					expect(result.stdout.trim()).toBe(expected);
					const events = parseCompilerCapture(readFileSync(`${capture}.compiler`));
					const diagnostic = spawnSync(built.binaryPath, [String(count), kind, "dense"], {
						env: {
							...process.env,
							MAL_PROFILE_CAPTURE: undefined,
							MAL_PROFILE_COMPILER: undefined,
							MAL_PERF_STATS: "1",
						},
						encoding: "utf8",
						timeout: 30000,
					});
					expect(diagnostic.status, diagnostic.stderr).toBe(0);
					expect(diagnostic.stdout.trim()).toBe(expected);
					const counters = probeCounters(diagnostic.stderr);
					expect(counters.prefix_admissions).toBe(count === 0 ? 0 : 1);
					expect(counters.prefix_invalidations).toBe(0);
					const counts = {
						private: 0,
						kernel: 0,
						array: 0,
						method: 0,
						indexed: 0,
						admissions: 0,
						checks: 0,
						generic: 0,
					};
					for (const [
						functionIndex,
						fn,
					] of built.programImage.native.functions.entries()) {
						if (names[functionIndex] !== name) continue;
						for (const [index, instruction] of fn.body.instructions.entries()) {
							const site = fn.body.profileSiteIds?.[index] ?? -1;
							const executions = site < 0 ? 0 : events.bySite[site]!.executions;
							if (instruction.opcode === "PROBE_READ") {
								if (instruction.readKind === "private") counts.private += executions;
								else if (instruction.readKind === "indexed") counts.indexed += executions;
								else if (instruction.readKind === "named") {
									const key = String.fromCodePoint(
										...built.programImage.runtime.stringConstants[
											instruction.stringIndex
										]!,
									);
									if (key === "kernel") counts.kernel += executions;
									if (key === readArray) counts.array += executions;
								}
							} else if (
								instruction.opcode === "GUARD_FUNCTION_INDEX" &&
								names[instruction.functionIndex] === accessor
							)
								counts.method += executions;
							else if (instruction.opcode === "READ_SERVICE_EPOCH")
								counts.admissions += executions;
							else if (instruction.opcode === "GUARD_SERVICE_EPOCH")
								counts.checks += executions;
							else if (instruction.opcode === "CALL") counts.generic += executions;
						}
					}
					expect(counts.admissions).toBe(count === 0 ? 0 : 1);
					expect(counts.checks).toBe(Math.max(count - 1, 0));
					expect(counts.method).toBe(count === 0 ? 0 : 1);
					expect(counts.array).toBe(count === 0 ? 0 : 1);
					expect(counts.indexed).toBe(count + (kind === "edge" ? 3 : 2));
					expect(counts.generic).toBe(0);
					const bodyExecutions = sites
						.filter((site) => names[site.functionIndex] === accessor)
						.reduce((sum, site) => sum + events.bySite[site.id]!.executions, 0);
					expect(bodyExecutions).toBe(0);
					if (count > 0) {
						const discovery = {
							private: counts.private,
							kernel: counts.kernel,
							array: counts.array,
							method: counts.method,
						};
						if (denseDiscovery === undefined) denseDiscovery = discovery;
						else expect(discovery).toEqual(denseDiscovery);
					}
					process.stdout.write(
						`${JSON.stringify({ kind, count, counts, counters, bodyExecutions })}\n`,
					);
				}
				for (const mode of ["hole", "service"]) {
					const result = spawnSync(
						built.binaryPath,
						["32", kind, mode === "hole" ? "hole" : "dense"],
						{
							env: {
								...process.env,
								...(mode === "service" ? STRESS_ENV : {}),
								MAL_PROFILE_CAPTURE: undefined,
								MAL_PROFILE_COMPILER: undefined,
								MAL_PERF_STATS: "1",
							},
							encoding: "utf8",
							timeout: 30_000,
						},
					);
					expect(result.status, result.stderr).toBe(0);
					expect(result.stdout.trim()).toBe(
						execFileSync(
							process.execPath,
							[fixturePath, "32", kind, mode === "hole" ? "hole" : "dense"],
							{ encoding: "utf8" },
						).trim(),
					);
					const counters = probeCounters(result.stderr);
					if (mode === "service") expect(counters.prefix_admissions).toBeGreaterThan(1);
					else expect(counters.indexed_hits).toBeLessThan(counters.indexed_attempts!);
					process.stdout.write(`${JSON.stringify({ kind, mode, counters })}\n`);
				}
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 600_000);

	it("completes indexed misses in the real kernel loop without entering accessors", () => {
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
			process.stdout.write(
				`${JSON.stringify({ mode: "expansion-disabled", counters: controlCounters })}\n`,
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
			const sites = built.programImage.profiling?.sites ?? [];
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
					expect(executions(name), `${mode}: ${name}`).toBe(0);
				const probes = { private: 0, named: 0, indexed: 0, getter: 0, setter: 0 };
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
					// Without the expansion, private reads guard on class layout cells instead.
					const controlLayout = probeCounters(control.stderr, "class-layout-stats");
					expect(counters.private_load_attempts).toBeLessThan(
						controlCounters.private_load_attempts! + controlLayout.slot_hits!,
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
				process.stdout.write(
					`${JSON.stringify({
						mode,
						probes,
						counters,
						accessorInstructionExecutions: Object.fromEntries(
							[...accessors].map((name) => [name, executions(name)]),
						),
					})}\n`,
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

	it("re-admits an inner loop prefix and continues after element and field changes", () => {
		const fixture = "tests/local/read-accessor-nested-loop-prefixes.mjs";
		const expected = execFileSync(process.execPath, [fixture], {
			encoding: "utf8",
		}).trim();
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "accessor-nested-loop-continuations",
			config: resolveBuildConfig({ engine: { primordials: "locked" } }),
		});
		for (const binary of [pair.compiled, pair.interpreted]) {
			expect(runToStdout(binary).trim()).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV }).trim()).toBe(expected);
		}
	}, 600_000);

	it("continues the current iteration after a hole, retirement, or method change", () => {
		const fixture = "tests/local/read-accessor-loop-prefixes.mjs";
		const expected = execFileSync(process.execPath, [fixture], {
			encoding: "utf8",
		}).trim();
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "accessor-loop-continuations",
			config: resolveBuildConfig({ engine: { primordials: "locked" } }),
		});
		for (const binary of [pair.compiled, pair.interpreted]) {
			expect(runToStdout(binary).trim()).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV }).trim()).toBe(expected);
		}
	}, 600_000);
});
