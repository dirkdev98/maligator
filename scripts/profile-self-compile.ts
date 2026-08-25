import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createProfileCapture,
	finalizeProfileCapture,
	prepareProfile,
} from "../src/profile-artifact.ts";
import { buildNativeBinaryResult } from "../src/test-harness.ts";
import {
	digestSelfCompileOutput,
	prepareSelfCompileSource,
	SELF_COMPILE_CONFIG,
} from "./self-compile-workload.ts";

interface PerfRecord {
	section: string;
	fields: Record<string, number | string>;
}

interface SelfCompileSummary {
	units: number;
	codeUnits: number;
	phases: Record<string, number>;
}

const HELP = `Usage: node scripts/profile-self-compile.ts [--quick] [--json-out PATH] [--sample-out PATH]

Build and run the fully closed self-compile workload with exact runtime counters.
This is a single-current-tree profile, not a base/head comparison.
--quick compiles the closed shape-analysis module cone through the same native
compiler and Core optimizer, providing a calibrated sub-minute inner loop.
--compiler-profile additionally records exact source-site execution, fallback,
allocation, boxing, safepoint, GC, and runtime-dispatch counters.
On macOS, --sample-out captures ten seconds of stacks during Core optimization.
`;

interface ProfileOptions {
	jsonOut: string;
	sampleOut?: string;
	quick: boolean;
	compilerProfile: boolean;
}

function profileOptions(args: Array<string>): ProfileOptions | undefined {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(HELP);
		return undefined;
	}
	const quick = args.includes("--quick");
	const compilerProfile = args.includes("--compiler-profile");
	let jsonOut = quick
		? ".cache/self-compile-quick-profile.json"
		: ".cache/self-compile-profile.json";
	let sampleOut: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const option = args[index];
		if (option === "--quick" || option === "--compiler-profile") continue;
		const value = args[index + 1];
		if (value === undefined || value.startsWith("-")) throw new Error(HELP.trim());
		if (option === "--json-out") jsonOut = value;
		else if (option === "--sample-out") sampleOut = value;
		else throw new Error(HELP.trim());
		index++;
	}
	return {
		jsonOut,
		quick,
		compilerProfile,
		...(sampleOut === undefined ? {} : { sampleOut }),
	};
}

function perfRecords(stderr: string): Array<PerfRecord> {
	const records: Array<PerfRecord> = [];
	for (const line of stderr.split("\n")) {
		const match = /^\[([^\]]+)](?: (.*))?$/.exec(line);
		if (match === null || !match[1]!.startsWith("perf-")) continue;
		const fields: Record<string, number | string> = {};
		for (const token of (match[2] ?? "").split(/\s+/)) {
			const separator = token.indexOf("=");
			if (separator < 0) continue;
			const name = token.slice(0, separator);
			const raw = token.slice(separator + 1);
			const number = Number(raw);
			fields[name] = raw !== "" && Number.isFinite(number) ? number : raw;
		}
		records.push({ section: match[1]!, fields });
	}
	return records;
}

interface ProfileProcessResult {
	status: number | null;
	stdout: string;
	stderr: string;
	wallMs: number;
}

async function runWithSample(
	binary: string,
	args: Array<string>,
	environment: NodeJS.ProcessEnv,
	sampleOut: string,
	sampleDelayMs: number,
	sampleSeconds: number,
): Promise<ProfileProcessResult> {
	const absoluteSample = path.resolve(sampleOut);
	mkdirSync(path.dirname(absoluteSample), { recursive: true });
	const startedAt = process.hrtime.bigint();
	const child = spawn(binary, args, {
		env: environment,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	const exit = new Promise<number | null>((resolve, reject) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("self-compile profile timed out after 900 seconds"));
		}, 900_000);
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("close", (status) => {
			clearTimeout(timeout);
			resolve(status);
		});
	});
	const sample = new Promise<void>((resolve, reject) => {
		setTimeout(() => {
			if (child.exitCode !== null || child.pid === undefined) {
				reject(new Error("self-compile exited before the Core optimization sample"));
				return;
			}
			const result = spawnSync(
				"/usr/bin/sample",
				[String(child.pid), String(sampleSeconds), "-file", absoluteSample],
				{ encoding: "utf8", timeout: 30_000 },
			);
			if (result.error !== undefined) reject(result.error);
			else if (result.status !== 0)
				reject(new Error(`sample failed (${String(result.status)}):\n${result.stderr}`));
			else resolve();
		}, sampleDelayMs);
	});
	try {
		const [status] = await Promise.all([exit, sample]);
		return {
			status,
			stdout,
			stderr,
			wallMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
		};
	} catch (error) {
		child.kill("SIGKILL");
		await exit;
		throw error;
	}
}

const options = profileOptions(process.argv.slice(2));
if (options !== undefined) {
	if (options.sampleOut !== undefined && process.platform !== "darwin") {
		throw new Error("--sample-out requires the macOS sample tool");
	}
	const root = mkdtempSync(path.join(os.tmpdir(), "mal-self-compile-profile-"));
	try {
		const buildEnvironment = { ...process.env, MAL_PERF_STATS: "1" };
		const buildStartedAt = process.hrtime.bigint();
		const built = buildNativeBinaryResult({
			fixture: "bench/self-compile.mts",
			name: "profile-self-compile",
			config: SELF_COMPILE_CONFIG,
			environment: buildEnvironment,
			profileEnabled: options.compilerProfile,
			translationUnits: true,
		});
		const binary = built.binaryPath;
		const buildMs = Number(process.hrtime.bigint() - buildStartedAt) / 1e6;
		const compilerProfile = options.compilerProfile
			? (() => {
					const prepared = prepareProfile(binary, built.programImage, "compiler");
					return {
						prepared,
						capture: createProfileCapture("self-compile", prepared),
					};
				})()
			: undefined;
		const prepareStartedAt = process.hrtime.bigint();
		const sourceRoot = path.join(root, "source");
		const fullTarget = prepareSelfCompileSource(sourceRoot);
		const target = options.quick
			? path.join(root, "source/src/compiler/core/core-ir-shape-provenance.ts")
			: fullTarget;
		const prepareMs = Number(process.hrtime.bigint() - prepareStartedAt) / 1e6;
		const output = path.join(root, "output");
		const runtimeEnvironment = {
			...buildEnvironment,
			...(compilerProfile?.capture.environment ?? {}),
			...(compilerProfile === undefined ? {} : { MAL_PROFILE_COMPILER: "1" }),
		};
		let result: ProfileProcessResult;
		if (options.sampleOut === undefined) {
			const startedAt = process.hrtime.bigint();
			const completed = spawnSync(binary, [target, output], {
				env: runtimeEnvironment,
				encoding: "utf8",
				maxBuffer: 64 * 1024 * 1024,
				timeout: 900_000,
			});
			if (completed.error !== undefined) throw completed.error;
			result = {
				status: completed.status,
				stdout: completed.stdout,
				stderr: completed.stderr,
				wallMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
			};
		} else {
			result = await runWithSample(
				binary,
				[target, output],
				runtimeEnvironment,
				options.sampleOut,
				options.quick ? 3_000 : 30_000,
				options.quick ? 5 : 10,
			);
		}
		if (result.status !== 0) {
			throw new Error(
				`profile self-compile failed (${String(result.status)}):\n${result.stderr}`,
			);
		}
		const summary = JSON.parse(result.stdout.trim()) as SelfCompileSummary;
		const records = perfRecords(result.stderr);
		if (records.length === 0 && !options.compilerProfile) {
			throw new Error("self-compile emitted no perf counters");
		}
		const finalizedCompilerProfile =
			compilerProfile === undefined
				? undefined
				: finalizeProfileCapture(
						compilerProfile.capture.directory,
						compilerProfile.prepared,
						"self-compile",
					);
		const report = {
			schema: 2,
			world: "closed",
			workload: options.quick ? "shape-analysis-cone" : "full-self-compile",
			buildMs,
			prepareMs,
			wallMs: result.wallMs,
			totalMs: buildMs + prepareMs + result.wallMs,
			...summary,
			digest: digestSelfCompileOutput(output, [
				path.resolve(sourceRoot),
				path.relative(process.cwd(), sourceRoot),
			]),
			perfRecords: records,
			...(finalizedCompilerProfile === undefined
				? {}
				: {
						compilerProfile: {
							directory: compilerProfile!.capture.directory,
							findings: finalizedCompilerProfile.findings,
						},
					}),
		};
		const absoluteOutput = path.resolve(options.jsonOut);
		mkdirSync(path.dirname(absoluteOutput), { recursive: true });
		writeFileSync(absoluteOutput, `${JSON.stringify(report, undefined, 2)}\n`);
		console.log(
			`self-compile ${options.quick ? "quick " : ""}profile: ${summary.units} units, ${summary.codeUnits} code units, ${(result.wallMs / 1000).toFixed(1)}s run / ${((buildMs + prepareMs + result.wallMs) / 1000).toFixed(1)}s total`,
		);
		console.log(`digest: ${report.digest}`);
		console.log(`runtime perf counter records: ${records.length}`);
		console.log(`raw profile: ${absoluteOutput}`);
		if (compilerProfile !== undefined) {
			console.log(`compiler profile: ${compilerProfile.capture.directory}`);
		}
		if (options.sampleOut !== undefined) {
			console.log(`Core optimization sample: ${path.resolve(options.sampleOut)}`);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
