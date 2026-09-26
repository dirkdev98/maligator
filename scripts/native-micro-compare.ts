import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type * as BuildConfig from "../src/build-config.ts";
import { createCacheLease } from "../src/cache-management.ts";
import type * as ArtifactCodec from "../src/compiler/target/compiler-artifact-codec.ts";
import type * as ProgramImage from "../src/compiler/target/program-image.ts";
import type { NativeBuildPhaseEvent } from "../src/native-build-context.ts";
import type * as Harness from "../src/test-harness.ts";
import { runBoundedProcess } from "./performance-process.ts";
import { loadRuntimeGapCatalog } from "./runtime-gap-catalog.ts";
import {
	assertRuntimeGapParity,
	calibrationScaleTimeoutCap,
	parseKernelOutput,
} from "./runtime-gap.ts";
import type { KernelOutput } from "./runtime-gap.ts";
import { cleanTestEnvironment } from "./test-environment.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_CASES = [
	"stable-shape-properties",
	"record-array-traversal",
	"direct-calls",
	"indirect-calls",
	"closure-calls",
	"short-lived-records",
	"heap-valued-projection",
	"chained-static-properties",
	"infrequent-getter-properties",
	"native-property-owned-3",
	"native-property-owned-6",
	"native-property-mixed-prototypes",
	"native-property-middle-getter",
];

const HELP = `Usage: node scripts/native-micro-compare.ts --base REF [options]

  --base REF                required compiler baseline, exported with git archive
  --case ID                 canonical runtime-gap case; repeatable
  --pairs N                 alternating baseline/candidate pairs (default: 7)
  --target-node-ms N         calibrated kernel target (default: 80)
  --case-timeout-ms N        limit for each kernel process (default: 30000)
  --budget-seconds N         whole-run budget including builds (default: 2400)
  --output DIRECTORY        new evidence directory (default: .cache/native-micro/<time>)
  --plan=json               print selected work without writing or building

The current checkout is the candidate. Both compilers build the same frozen fixture
paths, using matching package-lock.json and build plans. Each invocation includes
five in-process warmups; elapsedMs excludes startup and warmup. Node supplies the
checksum and operation-count oracle. Calibration is bounded by both native hosts.
Reports retain source/toolchain identities, build phases/cache reuse, generated C,
artifact and executable sizes, binary text size, every sample, and child logs.
Build times are single observations, not paired build-performance conclusions.
Exit 2 means failed or incomplete; completion does not declare a performance win.
`;

interface Options {
	base: string;
	cases: Array<string>;
	pairs: number;
	targetNodeMs: number;
	caseTimeoutMs: number;
	budgetSeconds: number;
	output: string;
	plan: boolean;
}

interface BuildRequest {
	root: string;
	fixture: string;
	id: string;
	output: string;
}

interface BuildEvidence {
	binaryPath: string;
	buildMs: number;
	executableBytes: number;
	executableSha256: string;
	binaryTextBytes: number;
	generatedCBytes: number;
	compilerArtifactBytes: number;
	compilerArtifactSha256: string;
	toolchain: string;
	plan: unknown;
	config: unknown;
}

interface Pair {
	order: ReadonlyArray<"baseline" | "candidate">;
	baseline: KernelOutput;
	candidate: KernelOutput;
	reductionPercent: number;
}

interface CaseEvidence {
	id: string;
	fixture: string;
	fixtureSha256: string;
	builds: Partial<Record<"baseline" | "candidate", BuildEvidence>>;
	samples: Array<{ label: string; output: KernelOutput }>;
	pairs: Array<Pair>;
	scale?: number;
	oracle?: KernelOutput;
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function writeJson(file: string, value: unknown): void {
	writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
	renameSync(`${file}.tmp`, file);
}

function git(args: Array<string>): string {
	const result = spawnSync("git", args, {
		cwd: ROOT,
		encoding: "utf8",
		timeout: 30_000,
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.error !== undefined) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr);
	return result.stdout;
}

function sourceIdentity() {
	const commit = git(["rev-parse", "HEAD"]).trim();
	const patch = git(["diff", "--binary", "HEAD"]);
	const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"])
		.split("\0")
		.filter(Boolean)
		.sort();
	const digest = createHash("sha256").update(commit).update(patch);
	for (const file of untracked) {
		const absolute = path.join(ROOT, file);
		const contents = lstatSync(absolute).isSymbolicLink()
			? Buffer.from(readlinkSync(absolute))
			: readFileSync(absolute);
		digest.update(`${file}\0${contents.length}\0`).update(contents);
	}
	return {
		commit,
		dirty: patch.length > 0 || untracked.length > 0,
		digest: digest.digest("hex"),
		lockfileSha256: sha256(readFileSync(path.join(ROOT, "package-lock.json"))),
	};
}

function fileManifest(directory: string): Record<string, string> {
	const files: Record<string, string> = {};
	const visit = (relative: string) => {
		const absolute = path.join(directory, relative);
		if (lstatSync(absolute).isDirectory()) {
			for (const name of readdirSync(absolute).sort()) visit(path.join(relative, name));
		} else files[relative] = sha256(readFileSync(absolute));
	};
	visit("");
	return files;
}

function median(values: ReadonlyArray<number>): number {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[middle - 1]! + sorted[middle]!) / 2
		: sorted[middle]!;
}

function summarize(pairs: ReadonlyArray<Pair>) {
	if (pairs.length === 0) return undefined;
	const reductions = pairs.map((pair) => pair.reductionPercent);
	const center = median(reductions);
	return {
		pairs: pairs.length,
		baselineMedianMs: median(pairs.map((pair) => pair.baseline.elapsedMs)),
		candidateMedianMs: median(pairs.map((pair) => pair.candidate.elapsedMs)),
		medianReductionPercent: center,
		madPercentagePoints: median(reductions.map((value) => Math.abs(value - center))),
		fasterPairs: reductions.filter((value) => value > 0).length,
	};
}

function parseOptions(args: Array<string>): Options | undefined {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(HELP);
		return undefined;
	}
	const options: Options = {
		base: "",
		cases: [],
		pairs: 7,
		targetNodeMs: 80,
		caseTimeoutMs: 30_000,
		budgetSeconds: 2400,
		output: path.join(
			ROOT,
			".cache/native-micro",
			new Date().toISOString().replaceAll(":", "-"),
		),
		plan: false,
	};
	while (args.length > 0) {
		const option = args.shift();
		if (option === "--plan=json") {
			options.plan = true;
			continue;
		}
		const value = args.shift();
		if (value === undefined || value.startsWith("--")) throw new Error(HELP);
		if (option === "--base") options.base = value;
		else if (option === "--case") options.cases.push(value);
		else if (option === "--output") options.output = path.resolve(value);
		else {
			const number = Number(value);
			if (!Number.isSafeInteger(number) || number < 1 || number > 2_147_483)
				throw new Error(`${option} requires an integer from 1 through 2147483`);
			if (option === "--pairs") options.pairs = number;
			else if (option === "--target-node-ms") options.targetNodeMs = number;
			else if (option === "--case-timeout-ms") options.caseTimeoutMs = number;
			else if (option === "--budget-seconds") options.budgetSeconds = number;
			else throw new Error(`unknown option: ${option}`);
		}
	}
	if (!options.base) throw new Error("--base REF is required");
	if (options.cases.length === 0) options.cases = DEFAULT_CASES;
	if (new Set(options.cases).size !== options.cases.length)
		throw new Error("--case IDs must not repeat");
	return options;
}

async function buildWorker(request: BuildRequest): Promise<void> {
	const load = (file: string) =>
		import(pathToFileURL(path.join(request.root, file)).href);
	const { resolveBuildConfig } = (await load(
		"src/build-config.ts",
	)) as typeof BuildConfig;
	const { buildNativeBinaryResult } = (await load(
		"src/test-harness.ts",
	)) as typeof Harness;
	const { serializeCompilerArtifact } = (await load(
		"src/compiler/target/compiler-artifact-codec.ts",
	)) as typeof ArtifactCodec;
	const { programImageStats } = (await load(
		"src/compiler/target/program-image.ts",
	)) as typeof ProgramImage;
	const config = resolveBuildConfig({
		engine: { eval: false, realms: false, regexp: false, intl: { enabled: false } },
		surface: { node: true, webPlatform: false, maligator: true },
	});
	const phases: Array<NativeBuildPhaseEvent> = [];
	const frontend: Array<unknown> = [];
	const nativeCaches: Array<unknown> = [];
	const started = performance.now();
	const built = buildNativeBinaryResult({
		fixture: request.fixture,
		name: request.id,
		entryGoal: "module",
		config,
		compiled: true,
		production: true,
		outDir: path.dirname(request.output),
		environment: cleanTestEnvironment(),
		onFrontendCacheEvent: (event) => frontend.push(event),
		onNativeCacheEvent: (event) => nativeCaches.push(event),
		onNativeBuildPhase: (event) => {
			phases.push(event);
			console.log(JSON.stringify(event));
		},
	});
	const buildMs = performance.now() - started;
	const artifact = serializeCompilerArtifact(built.programImage, { debugInfo: false });
	const size = spawnSync("size", ["--format=sysv", "--radix=10", built.binaryPath], {
		encoding: "utf8",
		timeout: 10_000,
		env: cleanTestEnvironment(),
	});
	writeFileSync(
		path.join(path.dirname(request.output), "binary-size.log"),
		`${size.stdout ?? ""}\n${size.stderr ?? ""}`,
	);
	if (size.error !== undefined) throw size.error;
	const textBytes = size.stdout.match(/^\.text\s+(\d+)\s/m)?.[1];
	if (size.status !== 0 || textBytes === undefined || !/^\d+$/.test(textBytes))
		throw new Error("size did not produce a decimal .text section measurement");
	const generated = phases.find((event) => event.phase === "write generated C");
	if (generated?.bytes === undefined) throw new Error("build omitted generated C size");
	writeJson(request.output, {
		binaryPath: built.binaryPath,
		buildMs,
		executableBytes: statSync(built.binaryPath).size,
		executableSha256: sha256(readFileSync(built.binaryPath)),
		binaryTextBytes: Number(textBytes),
		generatedCBytes: generated.bytes,
		compilerArtifactBytes: artifact.byteLength,
		compilerArtifactSha256: sha256(artifact),
		toolchain: built.context.toolchain.fingerprint,
		toolchainDetails: built.context.toolchain,
		plan: built.context.plan,
		config,
		entryGoal: "module",
		compiled: true,
		production: true,
		programImage: programImageStats(built.programImage),
		frontend,
		nativeCaches,
		phases,
		measurements: built.measurements,
	});
}

async function compare(options: Options): Promise<void> {
	const catalog = loadRuntimeGapCatalog();
	const selected = options.cases.map((id) => {
		const descriptor = catalog.cases.find((entry) => entry.id === id);
		if (descriptor === undefined) throw new Error(`unknown runtime-gap case: ${id}`);
		return descriptor;
	});
	const baselineCommit = git([
		"rev-parse",
		"--verify",
		`${options.base}^{commit}`,
	]).trim();
	const candidate = sourceIdentity();
	const baselineLockfile = sha256(git(["show", `${baselineCommit}:package-lock.json`]));
	if (baselineLockfile !== candidate.lockfileSha256)
		throw new Error("baseline and candidate package-lock.json differ");
	const plan = {
		schema: 1,
		options,
		baseline: { commit: baselineCommit, lockfileSha256: baselineLockfile },
		candidate,
		cases: selected.map(({ fixturePath: _fixturePath, ...descriptor }) => descriptor),
		builds: selected.length * 2,
		measuredPairs: selected.length * options.pairs,
		warmupBlocksPerProcess: 5,
		maximumCalibrationScale: 256,
		parity: ["id", "scale", "operations", "checksum"],
		output: options.output,
	};
	if (options.plan) {
		console.log(JSON.stringify(plan, null, 2));
		return;
	}
	if (existsSync(options.output))
		throw new Error(`output already exists: ${options.output}`);
	mkdirSync(options.output, { recursive: true });
	console.log(`native micro comparison: ${options.output}`);
	const deadline = performance.now() + options.budgetSeconds * 1000;
	const snapshot = path.join(options.output, "baseline-source");
	const archive = path.join(options.output, "baseline-source.tar");
	const fixtures = path.join(options.output, "fixtures");
	const cases: Array<CaseEvidence> = [];
	const report = {
		...plan,
		status: "running",
		complete: false,
		startedAt: new Date().toISOString(),
		host: {
			platform: process.platform,
			arch: process.arch,
			node: process.version,
			cpu: os.cpus()[0]?.model,
		},
		fixtureFiles: {} as Record<string, string>,
		baselineArchiveSha256: "",
		cases,
		error: undefined as string | undefined,
	};
	const save = () =>
		writeJson(path.join(options.output, "report.json"), {
			...report,
			cases: cases.map((entry) => ({ ...entry, summary: summarize(entry.pairs) })),
		});
	const remaining = (limit = Number.MAX_SAFE_INTEGER) => {
		const milliseconds = Math.floor(deadline - performance.now());
		if (milliseconds < 1) throw new Error("whole-run budget exhausted");
		return Math.min(milliseconds, limit);
	};
	const run = async (
		label: string,
		executable: string,
		args: Array<string>,
		cwd: string,
		limit?: number,
	) => {
		const log = path.join(options.output, "logs", `${label}.log`);
		mkdirSync(path.dirname(log), { recursive: true });
		writeFileSync(log, `${JSON.stringify({ executable, args, cwd })}\n`);
		const result = await runBoundedProcess(executable, args, {
			cwd,
			environment: cleanTestEnvironment(),
			timeoutMs: remaining(limit),
			onStdout: (chunk) => appendFileSync(log, chunk),
			onStderr: (chunk) => appendFileSync(log, chunk),
		});
		if (result.exitCode !== 0)
			throw new Error(`${label} exited ${result.exitCode}; see ${log}`);
		return result.stdout;
	};
	const lease = createCacheLease("native-micro-compare");
	save();
	try {
		await run(
			"archive",
			"git",
			["archive", "--format=tar", `--output=${archive}`, baselineCommit],
			ROOT,
		);
		report.baselineArchiveSha256 = sha256(readFileSync(archive));
		mkdirSync(snapshot);
		await run("extract", "tar", ["-xf", archive, "-C", snapshot], ROOT);
		symlinkSync(
			path.join(ROOT, "node_modules"),
			path.join(snapshot, "node_modules"),
			"dir",
		);
		cpSync(path.join(ROOT, "bench/runtime-gap"), fixtures, { recursive: true });
		report.fixtureFiles = fileManifest(fixtures);
		writeJson(path.join(options.output, "plan.json"), plan);
		for (const [caseIndex, descriptor] of selected.entries()) {
			console.log(`${descriptor.id}: build matching compilers`);
			const fixture = path.join(fixtures, descriptor.fixture);
			const entry: CaseEvidence = {
				id: descriptor.id,
				fixture,
				fixtureSha256: sha256(readFileSync(fixture)),
				builds: {},
				samples: [],
				pairs: [],
			};
			cases.push(entry);
			save();
			const order =
				caseIndex % 2 === 0
					? (["baseline", "candidate"] as const)
					: (["candidate", "baseline"] as const);
			for (const variant of order) {
				const buildDirectory = path.join(
					options.output,
					"builds",
					descriptor.id,
					variant,
				);
				mkdirSync(buildDirectory, { recursive: true });
				const request: BuildRequest = {
					root: variant === "baseline" ? snapshot : ROOT,
					fixture,
					id: descriptor.id,
					output: path.join(buildDirectory, "build.json"),
				};
				await run(
					`${descriptor.id}-build-${variant}`,
					process.execPath,
					[import.meta.filename, "--build-worker", JSON.stringify(request)],
					request.root,
				);
				entry.builds[variant] = JSON.parse(
					readFileSync(request.output, "utf8"),
				) as BuildEvidence;
				save();
			}
			const baseline = entry.builds.baseline!;
			const head = entry.builds.candidate!;
			if (
				baseline.toolchain !== head.toolchain ||
				!isDeepStrictEqual(baseline.plan, head.plan) ||
				!isDeepStrictEqual(baseline.config, head.config)
			)
				throw new Error(
					`${descriptor.id}: native toolchains/build plans/configurations differ`,
				);
			const kernel = async (
				label: string,
				host: "node" | "baseline" | "candidate",
				scale: number,
			) => {
				const output = parseKernelOutput(
					await run(
						`${descriptor.id}-${label}`,
						host === "node" ? process.execPath : entry.builds[host]!.binaryPath,
						host === "node" ? [fixture, String(scale), "5"] : [String(scale), "5"],
						ROOT,
						options.caseTimeoutMs,
					),
				);
				if (
					output.id !== descriptor.id ||
					output.scale !== scale ||
					!Number.isSafeInteger(output.operations) ||
					!Number.isFinite(output.checksum) ||
					!Number.isFinite(output.elapsedMs) ||
					output.elapsedMs <= 0
				)
					throw new Error(`${descriptor.id}: invalid kernel timing or work identity`);
				entry.samples.push({ label, output });
				save();
				return output;
			};
			const nodeCalibration = await kernel("calibrate-node", "node", 1);
			const baselineCalibration = await kernel("calibrate-baseline", "baseline", 1);
			const candidateCalibration = await kernel("calibrate-candidate", "candidate", 1);
			assertRuntimeGapParity(nodeCalibration, baselineCalibration);
			assertRuntimeGapParity(nodeCalibration, candidateCalibration);
			const slowerMs = Math.max(
				nodeCalibration.elapsedMs,
				baselineCalibration.elapsedMs,
				candidateCalibration.elapsedMs,
			);
			entry.scale = Math.min(
				256,
				Math.max(1, Math.ceil(options.targetNodeMs / nodeCalibration.elapsedMs)),
				calibrationScaleTimeoutCap(options.caseTimeoutMs, slowerMs, 5),
			);
			entry.oracle = await kernel("node-oracle", "node", entry.scale);
			for (const variant of ["baseline", "candidate"] as const)
				assertRuntimeGapParity(
					entry.oracle,
					await kernel(`warm-${variant}`, variant, entry.scale),
				);
			console.log(`${descriptor.id}: ${options.pairs} pairs at scale ${entry.scale}`);
			for (let index = 0; index < options.pairs; index++) {
				const pairOrder =
					index % 2 === 0
						? (["baseline", "candidate"] as const)
						: (["candidate", "baseline"] as const);
				const samples: Partial<Record<"baseline" | "candidate", KernelOutput>> = {};
				for (const variant of pairOrder) {
					const sample = await kernel(`pair-${index}-${variant}`, variant, entry.scale);
					assertRuntimeGapParity(entry.oracle, sample);
					samples[variant] = sample;
				}
				entry.pairs.push({
					order: pairOrder,
					baseline: samples.baseline!,
					candidate: samples.candidate!,
					reductionPercent:
						100 * (1 - samples.candidate!.elapsedMs / samples.baseline!.elapsedMs),
				});
				save();
			}
			console.log(JSON.stringify({ id: entry.id, ...summarize(entry.pairs) }));
		}
		if (!isDeepStrictEqual(candidate, sourceIdentity()))
			throw new Error("candidate source changed during comparison");
		if (!isDeepStrictEqual(report.fixtureFiles, fileManifest(fixtures)))
			throw new Error("frozen fixtures changed during comparison");
		report.status = "complete";
		report.complete = true;
	} catch (error) {
		report.error = error instanceof Error ? error.message : String(error);
		report.status = /budget|timed out|interrupted/.test(report.error)
			? "incomplete"
			: "failed";
		process.exitCode = 2;
		console.error(report.error);
	} finally {
		save();
		rmSync(snapshot, { recursive: true, force: true });
		rmSync(archive, { force: true });
		lease.release();
	}
	console.log(`${report.status}: ${path.join(options.output, "report.json")}`);
}

if (import.meta.main) {
	try {
		if (process.argv[2] === "--build-worker")
			await buildWorker(JSON.parse(process.argv[3]!) as BuildRequest);
		else {
			const options = parseOptions(process.argv.slice(2));
			if (options !== undefined) await compare(options);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 2;
	}
}
