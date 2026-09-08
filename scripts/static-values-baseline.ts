import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { resolveBuildConfig } from "../src/build-config.ts";
import { emitProgramImage } from "../src/compiler/target/emit-program-image.ts";
import type { NativeBuildPhaseEvent } from "../src/native-build-context.ts";
import { buildNativeBinaryResult } from "../src/test-harness.ts";
import { inspectStaticValueFunction } from "../tests/helpers/static-values.ts";

const outDir = path.resolve(process.argv[2] ?? ".cache/static-values-baseline");
mkdirSync(outDir, { recursive: true });
function write(name: string, value: unknown) {
	writeFileSync(
		path.join(outDir, name),
		`${JSON.stringify(
			value,
			(_key, value: unknown) => {
				if (value instanceof Map) return [...value];
				if (value instanceof Set) return [...(value as Set<unknown>)];
				if (typeof value === "bigint") return { bigint: String(value) };
				if (
					typeof value === "number" &&
					(!Number.isFinite(value) || Object.is(value, -0))
				)
					return { number: Object.is(value, -0) ? "-0" : String(value) };
				return value;
			},
			2,
		)}\n`,
	);
}

const source = readFileSync("tests/local/static-values-baseline.mjs", "utf8");
const compilation = [];
for (const profile of [false, true]) {
	for (const name of ["included", "discarded", "absent", "absentDiscarded"]) {
		const samples = [];
		for (let sample = 0; sample < 6; sample++) {
			const before = process.cpuUsage();
			const inspected = inspectStaticValueFunction(source, name, { profile });
			const cpu = process.cpuUsage(before);
			if (sample > 0)
				samples.push({
					wallMs: inspected.compileMs,
					cpuMs: (cpu.user + cpu.system) / 1000,
					phases: inspected.phases,
				});
			if (sample !== 5) continue;
			const prefix = `${name}-${profile ? "profiled" : "normal"}`;
			write(`${prefix}-core.json`, inspected.core);
			write(`${prefix}-execution.json`, inspected.execution);
			write(`${prefix}-image.json`, inspected.image);
			writeFileSync(path.join(outDir, `${prefix}.c`), inspected.c.source);
			compilation.push({
				name,
				profile,
				samples,
				structure: inspected.structure,
				cBytes: Buffer.byteLength(inspected.c.source),
				sourceBytes: Buffer.byteLength(source),
			});
		}
	}
}
write(
	"compiler-counters.json",
	inspectStaticValueFunction(source, "included", { counters: true }).coreReport,
);
write("compilation.json", compilation);
const fixture = "bench/static-values.mjs";
const config = resolveBuildConfig({ surface: { node: true } });
const builds = [];
const runs = [];
for (const profile of [false, true]) {
	for (const compiled of [true, false]) {
		const buildPhases: Array<NativeBuildPhaseEvent> = [];
		const before = performance.now();
		const result = buildNativeBinaryResult({
			fixture,
			name: `static-values-${compiled ? "native" : "interpreter"}-${profile ? "profiled" : "normal"}`,
			outDir,
			config,
			compiled,
			profileEnabled: profile,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
			onNativeBuildPhase: (phase) => buildPhases.push(phase),
		});
		builds.push({
			profile,
			compiled,
			wallMs: performance.now() - before,
			phases: buildPhases,
			executableBytes: statSync(result.binaryPath).size,
			cBytes: Buffer.byteLength(emitProgramImage(result.programImage, { compiled })),
			plan: result.context.plan,
			toolchain: result.context.toolchain,
		});
		for (const mode of ["never", "cold", "hot"]) {
			const expected = execFileSync(process.execPath, [fixture, mode], {
				encoding: "utf8",
			});
			for (let sample = 0; sample < 5; sample++) {
				const start = performance.now();
				const run = spawnSync(
					"/usr/bin/time",
					[process.platform === "darwin" ? "-l" : "-v", result.binaryPath, mode],
					{
						encoding: "utf8",
						env: {
							...process.env,
							MAL_GC_STATS: "1",
							MAL_PERF_STATS: "1",
							MAL_HOST_GC: "1",
						},
						maxBuffer: 8 * 1024 * 1024,
						timeout: 60_000,
					},
				);
				if (run.error !== undefined) throw run.error;
				if (run.status !== 0 || run.stdout !== expected)
					throw new Error(
						`Static-value ${mode} mismatch: ${run.status}\n${run.stdout}\n${run.stderr}`,
					);
				runs.push({
					profile,
					compiled,
					mode,
					sample,
					wallMs: performance.now() - start,
					stdout: run.stdout,
					resourceReport: run.stderr,
				});
			}
		}
	}
}
write("measurements.json", {
	schema: 1,
	revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
	status: execFileSync("git", ["status", "--short"], { encoding: "utf8" }),
	node: process.version,
	host: { platform: process.platform, arch: process.arch },
	config,
	builds,
	runs,
	maxCompilerRssKiB: process.resourceUsage().maxRSS,
});
console.log(path.join(outDir, "measurements.json"));
