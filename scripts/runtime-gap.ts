import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBuildConfig } from "../src/build-config.ts";
import { CommandProgress } from "../src/command-progress.ts";
import { runBoundedProcess } from "./performance-process.ts";
import {
	loadRuntimeGapCatalog,
	loadRuntimeGapExperiment,
	RUNTIME_GAP_CATALOG,
} from "./runtime-gap-catalog.ts";
import type {
	RuntimeGapCaseDescriptor,
	RuntimeGapCategory,
} from "./runtime-gap-catalog.ts";
import { cleanTestEnvironment } from "./test-environment.ts";
import { summarizeV8GcTrace } from "./v8-gc-trace.ts";

const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_JSON = path.join(REPOSITORY_ROOT, ".cache/performance/runtime-gap.json");
const DEFAULT_MARKDOWN = path.join(REPOSITORY_ROOT, ".cache/performance/runtime-gap.md");
const CONFIG = resolveBuildConfig({
	engine: { eval: false, realms: false, regexp: false, intl: { enabled: false } },
	surface: { node: true, webPlatform: false, maligator: true },
});

type KernelDescriptor = RuntimeGapCaseDescriptor & { readonly fixturePath: string };
type HostGapCategory = RuntimeGapCategory;

type Preset = "quick" | "survey" | "confirm";

export interface KernelOutput {
	readonly schema: 2;
	readonly workload: "runtime-gap-case-v2";
	readonly id: string;
	readonly scale: number;
	readonly operations: number;
	readonly checksum: number;
	readonly elapsedMs: number;
	readonly measurementStartMs: number;
	readonly measurementEndMs: number;
	readonly warmupMs: ReadonlyArray<number>;
	readonly allocatedBytes?: number;
	readonly collections?: number;
}

interface TimedKernelSample {
	readonly elapsedMs: number;
	readonly warmupMs: ReadonlyArray<number>;
	readonly allocatedBytes?: number;
	readonly collections?: number;
}

interface ResourceSample {
	readonly cpuMs: number;
	readonly peakRssBytes: number;
	readonly gcWallMs?: number;
	readonly gcEvents?: number;
	readonly sampledAllocatedBytes?: number;
	readonly allocationSamplingIntervalBytes?: number;
	readonly allocatedBytes?: number;
	readonly collections?: number;
	readonly peakLiveBytes?: number;
	readonly maxPauseMs?: number;
}

interface RuntimeGapBuildEvidence {
	readonly schema: 1;
	readonly binaryPath: string;
	readonly buildMs: number;
	readonly executableBytes: number;
	readonly compilerArtifactBytes: number;
	readonly compilerArtifactDigest: string;
	readonly programImage: {
		readonly functionCount: number;
		readonly instructionCount: number;
	};
	readonly frontend: ReadonlyArray<{
		readonly cache: "hit" | "miss";
		readonly entrypoint: string;
	}>;
	readonly nativeCaches: ReadonlyArray<unknown>;
	readonly phases: ReadonlyArray<unknown>;
	readonly measurements: unknown;
}

interface RuntimeGapFailure {
	readonly id: string;
	readonly status: "budget" | "timeout" | "incorrect" | "error";
	readonly message: string;
}

export interface CompilerHostGapKernelResult extends Omit<
	KernelDescriptor,
	"fixturePath"
> {
	readonly build: RuntimeGapBuildEvidence;
	readonly scale: number;
	readonly operations: number;
	readonly checksum: number;
	readonly node: {
		readonly samples: ReadonlyArray<TimedKernelSample>;
		readonly medianMs: number;
		readonly medianAbsoluteDeviationMs: number;
		readonly nsPerOperation: number;
		readonly resource?: ResourceSample;
		readonly resourceFailure?: string;
	};
	readonly maligator: {
		readonly samples: ReadonlyArray<TimedKernelSample>;
		readonly medianMs: number;
		readonly medianAbsoluteDeviationMs: number;
		readonly nsPerOperation: number;
		readonly resource?: ResourceSample;
		readonly resourceFailure?: string;
	};
	readonly ratio: number;
	readonly hostGapMs: number;
	readonly deltaNsPerOperation: number;
}

interface FullCompilerOwner {
	readonly id: number;
	readonly name: string;
	readonly nodeMs: number;
	readonly maligatorMs: number;
	readonly hostRatio: number | null;
	readonly hostGapMs: number;
	readonly workUnits: number;
	readonly nodeNsPerWorkUnit: number | null;
	readonly maligatorNsPerWorkUnit: number | null;
	readonly allocatedBytes?: number;
	readonly collections?: number;
}

interface FullCompilerAnalysis {
	readonly artifact: string;
	readonly source: unknown;
	readonly nodeMs: number;
	readonly maligatorMs: number;
	readonly ratio: number;
	readonly nodePhases: Readonly<Record<string, number>>;
	readonly maligatorPhases: Readonly<Record<string, number>>;
	readonly runtime: unknown;
	readonly nativeBuild: unknown;
	readonly coverage: {
		readonly nodeOptimizeCore: number;
		readonly maligatorOptimizeCore: number;
		readonly hostGap: number;
		readonly allocation?: number;
	};
	readonly owners: ReadonlyArray<
		FullCompilerOwner & {
			readonly representativeKernels: ReadonlyArray<string>;
			readonly category: HostGapCategory;
		}
	>;
	readonly topHostGap: ReadonlyArray<string>;
	readonly topAllocation: ReadonlyArray<string>;
	readonly categoryFractions: Readonly<Record<HostGapCategory, number>>;
	readonly actionableOwners: ReadonlyArray<string>;
}

interface Options {
	readonly samples: number;
	readonly targetNodeMs: number;
	readonly budgetSeconds: number;
	readonly caseTimeoutMs: number;
	readonly output: string;
	readonly markdown: string;
	readonly groups: ReadonlySet<KernelDescriptor["group"]>;
	readonly suites: ReadonlySet<KernelDescriptor["suite"]>;
	readonly categories: ReadonlySet<HostGapCategory>;
	readonly cases: ReadonlySet<string>;
	readonly skipNodeAllocation: boolean;
	readonly plan: boolean;
	readonly preset?: Preset;
	readonly selfCompile?: string;
	readonly experimentManifest?: string;
}

const HELP = `Usage: npm run bench:performance -- gap [options]

Options:
  --samples N                paired timing samples per host (default: 5)
  --target-node-ms N         minimum calibrated Node kernel time (default: 40)
  --budget-seconds N         whole-run budget including the shared build (default: 300)
  --case-timeout-ms N        timeout for one child invocation (default: 10000)
  --preset quick|survey|confirm
  --suite runtime|compiler
  --category NAME            select a report category; repeatable
  --group primitive|runtime|algorithm
  --case ID                  select a kernel; repeatable
  --output PATH              JSON report (default: .cache/performance/runtime-gap.json)
  --markdown PATH            Markdown report (default: .cache/performance/runtime-gap.md)
  --skip-node-allocation     omit V8 sampled-allocation resource probes
  --self-compile PATH        merge a full self-compile owner artifact
  --experiment-manifest PATH
                             include one scratch experiment case
  --plan=json                describe selected work without writing or building
`;

function requiredValue(args: ReadonlyArray<string>, index: number): string {
	const value = args[index + 1];
	if (value === undefined || value.startsWith("-")) throw new Error(HELP.trim());
	return value;
}

function positiveInteger(value: string, option: string): number {
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number < 1) {
		throw new Error(`${option} requires a positive integer`);
	}
	return number;
}

function parseOptions(args: ReadonlyArray<string>): Options | undefined {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(HELP);
		return undefined;
	}
	const presetIndex = args.indexOf("--preset");
	const presetValue = presetIndex < 0 ? undefined : args[presetIndex + 1];
	if (presetIndex >= 0 && presetValue === undefined) throw new Error(HELP.trim());
	if (
		presetValue !== undefined &&
		presetValue !== "quick" &&
		presetValue !== "survey" &&
		presetValue !== "confirm"
	) {
		throw new Error(`unknown preset: ${presetValue}`);
	}
	const preset = presetValue;
	let samples = preset === "quick" ? 3 : preset === "confirm" ? 9 : 5;
	let targetNodeMs = preset === "quick" ? 20 : preset === "confirm" ? 100 : 40;
	let budgetSeconds = 300;
	let caseTimeoutMs = 10_000;
	let output = DEFAULT_JSON;
	let markdown = DEFAULT_MARKDOWN;
	const groups = new Set<KernelDescriptor["group"]>();
	const suites = new Set<KernelDescriptor["suite"]>();
	const categories = new Set<HostGapCategory>();
	const cases = new Set<string>();
	let skipNodeAllocation = preset === "quick";
	let plan = false;
	let selfCompile: string | undefined;
	let experimentManifest: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const option = args[index]!;
		if (option === "--samples") {
			samples = positiveInteger(requiredValue(args, index), option);
			index++;
		} else if (option === "--target-node-ms") {
			targetNodeMs = positiveInteger(requiredValue(args, index), option);
			index++;
		} else if (option === "--budget-seconds") {
			budgetSeconds = positiveInteger(requiredValue(args, index), option);
			index++;
		} else if (option === "--case-timeout-ms") {
			caseTimeoutMs = positiveInteger(requiredValue(args, index), option);
			index++;
		} else if (option === "--preset") {
			index++;
		} else if (option === "--output") {
			output = path.resolve(requiredValue(args, index));
			index++;
		} else if (option === "--markdown") {
			markdown = path.resolve(requiredValue(args, index));
			index++;
		} else if (option === "--group") {
			const group = requiredValue(args, index);
			if (group !== "primitive" && group !== "runtime" && group !== "algorithm") {
				throw new Error(`unknown kernel group: ${group}`);
			}
			groups.add(group);
			index++;
		} else if (option === "--suite") {
			const suite = requiredValue(args, index);
			if (suite !== "runtime" && suite !== "compiler") {
				throw new Error(`unknown suite: ${suite}`);
			}
			suites.add(suite);
			index++;
		} else if (option === "--category") {
			categories.add(requiredValue(args, index) as HostGapCategory);
			index++;
		} else if (option === "--case") {
			cases.add(requiredValue(args, index));
			index++;
		} else if (option === "--skip-node-allocation") {
			skipNodeAllocation = true;
		} else if (option === "--plan=json") {
			plan = true;
		} else if (option === "--self-compile") {
			selfCompile = path.resolve(requiredValue(args, index));
			index++;
		} else if (option === "--experiment-manifest") {
			experimentManifest = path.resolve(requiredValue(args, index));
			index++;
		} else {
			throw new Error(`unknown option: ${option}`);
		}
	}
	return {
		samples,
		targetNodeMs,
		budgetSeconds,
		caseTimeoutMs,
		output,
		markdown,
		groups,
		suites,
		categories,
		cases,
		skipNodeAllocation,
		plan,
		...(preset === undefined ? {} : { preset }),
		...(selfCompile === undefined ? {} : { selfCompile }),
		...(experimentManifest === undefined ? {} : { experimentManifest }),
	};
}

function runProcess(
	command: string,
	args: ReadonlyArray<string>,
	environment: NodeJS.ProcessEnv = process.env,
	timeoutMs = 900_000,
): { readonly stdout: string; readonly stderr: string } {
	const completed = spawnSync(command, [...args], {
		env: environment,
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
		timeout: timeoutMs,
	});
	if (completed.error !== undefined) throw completed.error;
	if (completed.status !== 0) {
		throw new Error(
			`runtime-gap process failed (${String(completed.status)}): ${command} ${args.join(" ")}\n${completed.stdout}\n${completed.stderr}`,
		);
	}
	return { stdout: String(completed.stdout), stderr: String(completed.stderr) };
}

export function parseKernelOutput(stdout: string): KernelOutput {
	for (const line of stdout.trim().split("\n").filter(Boolean).reverse()) {
		let parsed: Partial<KernelOutput>;
		try {
			parsed = JSON.parse(line) as Partial<KernelOutput>;
		} catch {
			continue;
		}
		if (
			parsed.schema === 2 &&
			parsed.workload === "runtime-gap-case-v2" &&
			typeof parsed.id === "string" &&
			typeof parsed.operations === "number" &&
			parsed.operations > 0 &&
			typeof parsed.checksum === "number" &&
			typeof parsed.elapsedMs === "number" &&
			parsed.elapsedMs >= 0 &&
			typeof parsed.measurementStartMs === "number" &&
			typeof parsed.measurementEndMs === "number" &&
			parsed.measurementEndMs >= parsed.measurementStartMs &&
			Array.isArray(parsed.warmupMs) &&
			parsed.warmupMs.every((value) => typeof value === "number" && value >= 0)
		) {
			return parsed as KernelOutput;
		}
	}
	throw new Error("runtime-gap case produced no valid result record");
}

function runKernel(
	command: string,
	args: ReadonlyArray<string>,
	timeoutMs: number,
): KernelOutput {
	return parseKernelOutput(
		runProcess(command, args, cleanTestEnvironment(), timeoutMs).stdout,
	);
}

function median(values: ReadonlyArray<number>): number {
	if (values.length === 0) throw new Error("median requires at least one value");
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[middle - 1]! + sorted[middle]!) / 2
		: sorted[middle]!;
}

function medianAbsoluteDeviation(values: ReadonlyArray<number>): number {
	const center = median(values);
	return median(values.map((value) => Math.abs(value - center)));
}

function timeInvocation(
	command: string,
	args: ReadonlyArray<string>,
	environment: NodeJS.ProcessEnv,
	timeoutMs: number,
): {
	readonly output: KernelOutput;
	readonly cpuMs: number;
	readonly peakRssBytes: number;
	readonly stderr: string;
	readonly traceOutput: string;
} {
	const timeFlag = process.platform === "darwin" ? "-l" : "-v";
	const completed = runProcess(
		"/usr/bin/time",
		[timeFlag, command, ...args],
		environment,
		timeoutMs,
	);
	const stderr = completed.stderr;
	const macCpu = stderr.match(/([0-9.]+)\s+user\s+([0-9.]+)\s+sys/);
	const linuxUser = stderr.match(/User time \(seconds\):\s*([0-9.]+)/);
	const linuxSystem = stderr.match(/System time \(seconds\):\s*([0-9.]+)/);
	const cpuMs =
		macCpu === null
			? (Number(linuxUser?.[1] ?? 0) + Number(linuxSystem?.[1] ?? 0)) * 1_000
			: (Number(macCpu[1]) + Number(macCpu[2])) * 1_000;
	const macRss = stderr.match(/([0-9]+)\s+maximum resident set size/);
	const linuxRss = stderr.match(/Maximum resident set size \(kbytes\):\s*([0-9]+)/);
	const peakRssBytes =
		macRss === null ? Number(linuxRss?.[1] ?? 0) * 1_024 : Number(macRss[1]);
	if (cpuMs <= 0 || peakRssBytes <= 0) {
		throw new Error(`resource report omitted CPU or RSS:\n${stderr}`);
	}
	return {
		output: parseKernelOutput(completed.stdout),
		cpuMs,
		peakRssBytes,
		stderr,
		traceOutput: `${completed.stdout}\n${stderr}`,
	};
}

function gcStat(stderr: string, name: string): number | undefined {
	const match = stderr.match(new RegExp(`${name}=([0-9.]+)`));
	return match === null ? undefined : Number(match[1]);
}

function profileSelfSize(node: unknown): number {
	if (typeof node !== "object" || node === null) return 0;
	const record = node as { selfSize?: unknown; children?: unknown };
	const own = typeof record.selfSize === "number" ? record.selfSize : 0;
	const children = Array.isArray(record.children) ? record.children : [];
	return (
		own +
		children.reduce((sum: number, child: unknown) => sum + profileSelfSize(child), 0)
	);
}

function nodeResourceSample(
	fixture: string,
	scale: number,
	sampleAllocation: boolean,
	timeoutMs: number,
	reference: KernelOutput,
): ResourceSample {
	if (!sampleAllocation) {
		const measured = timeInvocation(
			process.execPath,
			["--trace-gc-nvp", fixture, String(scale)],
			cleanTestEnvironment(),
			timeoutMs,
		);
		assertRuntimeGapParity(reference, measured.output);
		const gc = summarizeV8GcTrace(
			measured.traceOutput,
			measured.output.measurementStartMs,
			measured.output.measurementEndMs,
		);
		return {
			cpuMs: measured.cpuMs,
			peakRssBytes: measured.peakRssBytes,
			gcWallMs: gc.wallMs,
			gcEvents: gc.events,
			maxPauseMs: gc.maximumPauseMs,
		};
	}
	const profileRoot = mkdtempSync(path.join(os.tmpdir(), "mal-host-gap-heap-"));
	try {
		const interval = 1_024;
		const measured = timeInvocation(
			process.execPath,
			[
				"--trace-gc-nvp",
				"--heap-prof",
				`--heap-prof-interval=${interval}`,
				`--heap-prof-dir=${profileRoot}`,
				fixture,
				String(scale),
			],
			cleanTestEnvironment(),
			timeoutMs,
		);
		assertRuntimeGapParity(reference, measured.output);
		const profileName = readdirSync(profileRoot).find((name) =>
			name.endsWith(".heapprofile"),
		);
		if (profileName === undefined)
			throw new Error("Node allocation probe wrote no heap profile");
		const profile = JSON.parse(
			readFileSync(path.join(profileRoot, profileName), "utf8"),
		) as {
			head?: unknown;
		};
		const gc = summarizeV8GcTrace(
			measured.traceOutput,
			measured.output.measurementStartMs,
			measured.output.measurementEndMs,
		);
		return {
			cpuMs: measured.cpuMs,
			peakRssBytes: measured.peakRssBytes,
			gcWallMs: gc.wallMs,
			gcEvents: gc.events,
			maxPauseMs: gc.maximumPauseMs,
			sampledAllocatedBytes: profileSelfSize(profile.head),
			allocationSamplingIntervalBytes: interval,
		};
	} finally {
		rmSync(profileRoot, { recursive: true, force: true });
	}
}

function maligatorResourceSample(
	binary: string,
	scale: number,
	timeoutMs: number,
	reference: KernelOutput,
): ResourceSample {
	const measured = timeInvocation(
		binary,
		[String(scale)],
		cleanTestEnvironment({
			MAL_GC_STATS: "1",
			MAL_GC_CONTROL: "1",
		}),
		timeoutMs,
	);
	assertRuntimeGapParity(reference, measured.output);
	return {
		cpuMs: measured.cpuMs,
		peakRssBytes: measured.peakRssBytes,
		gcWallMs: gcStat(measured.stderr, "total_ms"),
		gcEvents: measured.output.collections,
		allocatedBytes: measured.output.allocatedBytes,
		collections: measured.output.collections,
		peakLiveBytes: gcStat(measured.stderr, "peak_live_bytes"),
		maxPauseMs: gcStat(measured.stderr, "max_pause_ms"),
	};
}

export class RuntimeGapParityError extends Error {}

export function assertRuntimeGapParity(
	reference: KernelOutput,
	actual: KernelOutput,
): void {
	if (
		reference.id !== actual.id ||
		reference.scale !== actual.scale ||
		reference.operations !== actual.operations ||
		reference.checksum !== actual.checksum
	) {
		throw new RuntimeGapParityError(
			`kernel work differs between hosts: ${JSON.stringify(reference)} != ${JSON.stringify(actual)}`,
		);
	}
}

export function captureOptionalResource<T>(probe: () => T): {
	readonly resource?: T;
	readonly resourceFailure?: string;
} {
	try {
		return { resource: probe() };
	} catch (error) {
		if (error instanceof RuntimeGapParityError) throw error;
		return { resourceFailure: error instanceof Error ? error.message : String(error) };
	}
}

function invocationTimeout(deadline: number, caseTimeoutMs: number): number {
	const remaining = Math.floor(deadline - performance.now() - 250);
	if (remaining < 1) throw new Error("runtime-gap budget exhausted");
	return Math.min(caseTimeoutMs, remaining);
}

function calibrateScale(
	binary: string,
	descriptor: KernelDescriptor,
	targetNodeMs: number,
	deadline: number,
	caseTimeoutMs: number,
): number {
	const node = runKernel(
		process.execPath,
		[descriptor.fixturePath, "1"],
		invocationTimeout(deadline, caseTimeoutMs),
	);
	const maligator = runKernel(binary, ["1"], invocationTimeout(deadline, caseTimeoutMs));
	assertRuntimeGapParity(node, maligator);
	const fasterMs = Math.max(0.01, Math.min(node.elapsedMs, maligator.elapsedMs));
	const slowerMs = Math.max(node.elapsedMs, maligator.elapsedMs);
	const targetScale = Math.max(1, Math.ceil(targetNodeMs / fasterMs));
	const slowerScale = Math.max(
		1,
		Math.floor((caseTimeoutMs * 0.5) / Math.max(1, slowerMs)),
	);
	return Math.min(256, targetScale, slowerScale);
}

function timedSample(output: KernelOutput): TimedKernelSample {
	return {
		elapsedMs: output.elapsedMs,
		warmupMs: output.warmupMs,
		...(output.allocatedBytes === undefined
			? {}
			: { allocatedBytes: output.allocatedBytes }),
		...(output.collections === undefined ? {} : { collections: output.collections }),
	};
}

function measureKernel(
	binary: string,
	build: RuntimeGapBuildEvidence,
	descriptor: KernelDescriptor,
	options: Pick<
		Options,
		"samples" | "targetNodeMs" | "skipNodeAllocation" | "caseTimeoutMs"
	>,
	deadline: number,
): CompilerHostGapKernelResult {
	const scale = calibrateScale(
		binary,
		descriptor,
		options.targetNodeMs,
		deadline,
		options.caseTimeoutMs,
	);
	const nodeSamples: Array<TimedKernelSample> = [];
	const maligatorSamples: Array<TimedKernelSample> = [];
	let reference: KernelOutput | undefined;
	for (let sample = 0; sample < options.samples; sample++) {
		const runNode = (): KernelOutput =>
			runKernel(
				process.execPath,
				[descriptor.fixturePath, String(scale)],
				invocationTimeout(deadline, options.caseTimeoutMs),
			);
		const runMaligator = (): KernelOutput =>
			runKernel(
				binary,
				[String(scale)],
				invocationTimeout(deadline, options.caseTimeoutMs),
			);
		const ordered = sample % 2 === 0 ? [runNode, runMaligator] : [runMaligator, runNode];
		const first = ordered[0]!();
		const second = ordered[1]!();
		const node = sample % 2 === 0 ? first : second;
		const maligator = sample % 2 === 0 ? second : first;
		reference ??= node;
		assertRuntimeGapParity(reference, node);
		assertRuntimeGapParity(reference, maligator);
		nodeSamples.push(timedSample(node));
		maligatorSamples.push(timedSample(maligator));
	}
	const nodeMedianMs = median(nodeSamples.map(({ elapsedMs }) => elapsedMs));
	const maligatorMedianMs = median(maligatorSamples.map(({ elapsedMs }) => elapsedMs));
	const nodeDeviationMs = medianAbsoluteDeviation(
		nodeSamples.map(({ elapsedMs }) => elapsedMs),
	);
	const maligatorDeviationMs = medianAbsoluteDeviation(
		maligatorSamples.map(({ elapsedMs }) => elapsedMs),
	);
	const operations = reference!.operations;
	const { fixturePath: _fixturePath, ...reportDescriptor } = descriptor;
	const nodeResource = captureOptionalResource(() =>
		nodeResourceSample(
			descriptor.fixturePath,
			scale,
			!options.skipNodeAllocation,
			invocationTimeout(deadline, options.caseTimeoutMs),
			reference!,
		),
	);
	const maligatorResource = captureOptionalResource(() =>
		maligatorResourceSample(
			binary,
			scale,
			invocationTimeout(deadline, options.caseTimeoutMs),
			reference!,
		),
	);
	return {
		...reportDescriptor,
		build,
		scale,
		operations,
		checksum: reference!.checksum,
		node: {
			samples: nodeSamples,
			medianMs: nodeMedianMs,
			medianAbsoluteDeviationMs: nodeDeviationMs,
			nsPerOperation: (nodeMedianMs * 1e6) / operations,
			...nodeResource,
		},
		maligator: {
			samples: maligatorSamples,
			medianMs: maligatorMedianMs,
			medianAbsoluteDeviationMs: maligatorDeviationMs,
			nsPerOperation: (maligatorMedianMs * 1e6) / operations,
			...maligatorResource,
		},
		ratio: maligatorMedianMs / nodeMedianMs,
		hostGapMs: maligatorMedianMs - nodeMedianMs,
		deltaNsPerOperation: ((maligatorMedianMs - nodeMedianMs) * 1e6) / operations,
	};
}

export interface RuntimeGapCategorySummary {
	readonly cases: number;
	readonly medianRatio: number;
	readonly minimumRatio: number;
	readonly maximumRatio: number;
}

export function summarizeRuntimeGapCategories(
	results: ReadonlyArray<CompilerHostGapKernelResult>,
): Readonly<Record<string, RuntimeGapCategorySummary>> {
	const categories = [...new Set(results.map(({ category }) => category))].sort();
	return Object.freeze(
		Object.fromEntries(
			categories.map((category) => {
				const ratios = results
					.filter((result) => result.category === category)
					.map(({ ratio }) => ratio);
				return [
					category,
					Object.freeze({
						cases: ratios.length,
						medianRatio: median(ratios),
						minimumRatio: Math.min(...ratios),
						maximumRatio: Math.max(...ratios),
					}),
				];
			}),
		),
	);
}

function representativeKernelIds(owner: string): ReadonlyArray<string> {
	const name = owner.toLowerCase();
	if (name.includes("semantic-to-core")) return ["pruned-ssa", "short-lived-records"];
	if (name.includes("verification")) return ["set-operations", "stable-shape-properties"];
	if (name.includes("program-flow convergence")) return ["program-flow-convergence"];
	if (name.includes("program-flow") || name.includes("call graph")) {
		return ["program-flow-extraction", "indirect-calls"];
	}
	if (name.includes("value kind")) return ["value-kinds"];
	if (name.includes("fused local")) return ["optimizer-queue"];
	if (name.includes("block-parameter")) return ["block-parameters"];
	if (name.includes("forwarding") || name.includes("other function")) {
		return ["optimizer-queue", "candidate-ranking"];
	}
	if (name.includes("cfg") || name.includes("control-flow")) return ["cfg-edges"];
	if (name.includes("dominator")) return ["immediate-dominators"];
	if (name.includes("canonical")) return ["canonical-roots"];
	if (name.includes("provenance") || name.includes("fact")) return ["fact-provenance"];
	if (name.includes("memoryversions")) return ["memory-versions"];
	if (name.includes("memory event")) return ["memory-events"];
	if (name.includes("core-to-execution")) return ["core-to-execution"];
	if (name.includes("execution-to-image")) return ["core-to-execution"];
	if (name.includes("emission")) return ["string-keys", "spread-copies"];
	if (name.includes("dense generation")) return ["dense-relocation"];
	if (name.includes("specialization") || name.includes("cross-call")) {
		return ["candidate-ranking", "closure-calls"];
	}
	if (name.includes("construction")) return ["pruned-ssa", "moderate-retention-churn"];
	return [];
}

function ownerCategory(owner: string): HostGapCategory {
	const name = owner.toLowerCase();
	if (
		name.includes("construction") ||
		name.includes("emission") ||
		name.includes("lowering")
	) {
		return "allocation-gc";
	}
	if (
		name.includes("memory") ||
		name.includes("verification") ||
		name.includes("block-parameter")
	) {
		return "api-builtins";
	}
	if (name.includes("specialization") || name.includes("cross-call")) {
		return "language-features";
	}
	if (
		name.includes("value kind") ||
		name.includes("program-flow") ||
		name.includes("fused local") ||
		name.includes("cfg") ||
		name.includes("control-flow") ||
		name.includes("dominator") ||
		name.includes("canonical") ||
		name.includes("dense generation")
	) {
		return "statements-operators";
	}
	return "compiler-algorithms";
}

function ownerCategoryFractions(
	owners: ReadonlyArray<FullCompilerOwner & { readonly category: HostGapCategory }>,
): Readonly<Record<HostGapCategory, number>> {
	const categories: ReadonlyArray<HostGapCategory> = [
		"statements-operators",
		"api-builtins",
		"language-features",
		"object-array-representation",
		"allocation-gc",
		"memory-layout-usage",
		"host-apis",
		"compiler-algorithms",
		"unattributed-execution",
	];
	const positiveGap = owners.reduce(
		(sum, owner) => sum + Math.max(0, owner.hostGapMs),
		0,
	);
	return Object.freeze(
		Object.fromEntries(
			categories.map((category) => [
				category,
				positiveGap === 0
					? 0
					: owners
							.filter((owner) => owner.category === category)
							.reduce((sum, owner) => sum + Math.max(0, owner.hostGapMs), 0) /
						positiveGap,
			]),
		) as Record<HostGapCategory, number>,
	);
}

function loadFullCompilerAnalysis(
	file: string,
	kernelIds: ReadonlySet<string>,
): FullCompilerAnalysis {
	const snapshot = JSON.parse(readFileSync(file, "utf8")) as {
		readonly source?: unknown;
		readonly selfCompile?: {
			readonly nodeMs?: number;
			readonly maligatorMs?: number;
			readonly nodePhases?: Readonly<Record<string, number>>;
			readonly maligatorPhases?: Readonly<Record<string, number>>;
			readonly runtime?: unknown;
			readonly nativeBuild?: unknown;
			readonly ownerSample?: {
				readonly owners?: ReadonlyArray<FullCompilerOwner>;
				readonly coverage?: FullCompilerAnalysis["coverage"];
			};
		};
	};
	const selfCompile = snapshot.selfCompile;
	const owners = selfCompile?.ownerSample?.owners;
	const coverage = selfCompile?.ownerSample?.coverage;
	if (
		selfCompile === undefined ||
		typeof selfCompile.nodeMs !== "number" ||
		typeof selfCompile.maligatorMs !== "number" ||
		selfCompile.nodePhases === undefined ||
		selfCompile.maligatorPhases === undefined ||
		owners === undefined ||
		owners.length === 0 ||
		coverage === undefined
	) {
		throw new Error(`${file} is not a completed self-compile owner artifact`);
	}
	const nodeMs = selfCompile.nodeMs;
	const maligatorMs = selfCompile.maligatorMs;
	const classified = owners.map((owner) => ({
		...owner,
		representativeKernels: representativeKernelIds(owner.name).filter((id) =>
			kernelIds.has(id),
		),
		category: ownerCategory(owner.name),
	}));
	const byGap = [...classified].sort((left, right) => right.hostGapMs - left.hostGapMs);
	const byAllocation = [...classified].sort(
		(left, right) => (right.allocatedBytes ?? 0) - (left.allocatedBytes ?? 0),
	);
	return {
		artifact: path.relative(REPOSITORY_ROOT, file),
		source: snapshot.source,
		nodeMs,
		maligatorMs,
		ratio: maligatorMs / nodeMs,
		nodePhases: selfCompile.nodePhases,
		maligatorPhases: selfCompile.maligatorPhases,
		runtime: selfCompile.runtime,
		nativeBuild: selfCompile.nativeBuild,
		coverage,
		owners: classified,
		topHostGap: byGap.slice(0, 5).map(({ name }) => name),
		topAllocation: byAllocation.slice(0, 5).map(({ name }) => name),
		categoryFractions: ownerCategoryFractions(classified),
		actionableOwners: byGap
			.filter(
				(owner) => (owner.hostRatio ?? 0) > 7 && owner.maligatorMs / maligatorMs >= 0.03,
			)
			.map(({ name }) => name),
	};
}

function row(result: CompilerHostGapKernelResult): string {
	const nodeDispersion =
		(100 * result.node.medianAbsoluteDeviationMs) / Math.max(0.001, result.node.medianMs);
	const maligatorDispersion =
		(100 * result.maligator.medianAbsoluteDeviationMs) /
		Math.max(0.001, result.maligator.medianMs);
	const allocatedPerOperation =
		result.maligator.resource?.allocatedBytes === undefined
			? "n/a"
			: (result.maligator.resource.allocatedBytes / result.operations).toFixed(2);
	const rss = `${
		result.node.resource === undefined
			? "n/a"
			: (result.node.resource.peakRssBytes / 1024 / 1024).toFixed(1)
	}/${
		result.maligator.resource === undefined
			? "n/a"
			: (result.maligator.resource.peakRssBytes / 1024 / 1024).toFixed(1)
	}`;
	return `| ${result.id} | ${result.inputShape} | ${result.node.nsPerOperation.toFixed(1)} | ${result.maligator.nsPerOperation.toFixed(1)} | ${result.ratio.toFixed(2)}x | ${result.deltaNsPerOperation.toFixed(1)} | ${nodeDispersion.toFixed(1)}%/${maligatorDispersion.toFixed(1)}% | ${allocatedPerOperation} | ${rss} | ok |`;
}

function markdownReport(report: {
	readonly status: string;
	readonly complete: boolean;
	readonly source: { readonly commit: string; readonly dirty: boolean };
	readonly results: ReadonlyArray<CompilerHostGapKernelResult>;
	readonly failures: ReadonlyArray<RuntimeGapFailure>;
	readonly fullCompiler?: FullCompilerAnalysis;
	readonly diagnosis: {
		readonly topHostGap: ReadonlyArray<string>;
		readonly topAllocation: ReadonlyArray<string>;
		readonly categorySummaries: Readonly<Record<string, RuntimeGapCategorySummary>>;
	};
}): string {
	const table = (rows: ReadonlyArray<CompilerHostGapKernelResult>): string =>
		[
			"| Case | Input shape | Node ns/op | Maligator ns/op | Ratio | Delta ns/op | Node/Maligator MAD | Maligator bytes/op | Node/Maligator peak RSS MiB | Status |",
			"| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
			...rows.map(row),
		].join("\n");
	const categorySections = Object.keys(report.diagnosis.categorySummaries)
		.sort()
		.map(
			(category) => `## ${category}

${table(report.results.filter((result) => result.category === category))}`,
		)
		.join("\n\n");
	const failureSection =
		report.failures.length === 0
			? ""
			: `## Incomplete cases

${report.failures.map((failure) => `- ${failure.id}: ${failure.status} - ${failure.message}`).join("\n")}
`;
	const fullCompilerSection =
		report.fullCompiler === undefined
			? "## Full compiler owners\n\nNo full self-compile owner artifact was supplied.\n"
			: `## Full compiler owners

Artifact: \`${report.fullCompiler.artifact}\`

- Warm total: ${report.fullCompiler.nodeMs.toFixed(1)} ms Node, ${report.fullCompiler.maligatorMs.toFixed(1)} ms Maligator, ${report.fullCompiler.ratio.toFixed(2)}x
- Optimizer attribution: ${(report.fullCompiler.coverage.nodeOptimizeCore * 100).toFixed(1)}% Node, ${(report.fullCompiler.coverage.maligatorOptimizeCore * 100).toFixed(1)}% Maligator
- Host-gap attribution: ${(report.fullCompiler.coverage.hostGap * 100).toFixed(1)}%
- Allocation attribution: ${report.fullCompiler.coverage.allocation === undefined ? "unavailable" : `${(report.fullCompiler.coverage.allocation * 100).toFixed(1)}%`}
- Top host-gap owners: ${report.fullCompiler.topHostGap.join(", ")}
- Top Maligator allocation owners: ${report.fullCompiler.topAllocation.join(", ")}
- Slice 3 ranking qualifiers: ${report.fullCompiler.actionableOwners.join(", ") || "none"}

| Owner | Node ms | Maligator ms | Ratio | Gap ms | Maligator allocated bytes | Representative kernels |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
${[...report.fullCompiler.owners]
	.sort((left, right) => right.hostGapMs - left.hostGapMs)
	.map(
		(owner) =>
			`| ${owner.name} | ${owner.nodeMs.toFixed(1)} | ${owner.maligatorMs.toFixed(1)} | ${owner.hostRatio === null ? "n/a" : `${owner.hostRatio.toFixed(2)}x`} | ${owner.hostGapMs.toFixed(1)} | ${owner.allocatedBytes?.toLocaleString() ?? "n/a"} | ${owner.representativeKernels.join(", ") || "unmapped"} |`,
	)
	.join("\n")}

Associated positive full-compiler owner-gap fractions:

${Object.entries(report.fullCompiler.categoryFractions)
	.map(([category, fraction]) => `- ${category}: ${(fraction * 100).toFixed(1)}%`)
	.join("\n")}

The category association maps measured owner gaps to their representative kernels; it is a ranking model, not a claim that one primitive alone explains an owner's complete cost.
`;
	return `# Runtime gap analysis

Source: \`${report.source.commit}\`${report.source.dirty ? " with benchmark changes" : ""}

Status: ${report.status}${report.complete ? "" : " (incomplete)"}

These same-source Node/Maligator cases are diagnostic evidence, not product baseline lanes. Headline timings use ordinary production execution; CPU, RSS, allocation, and GC data come from separate resource probes. Node sampled allocation and Maligator charged managed-heap allocation have different provenance and are not directly equivalent.

## Diagnosis

- Top host-gap kernels: ${report.diagnosis.topHostGap.join(", ")}
- Top Maligator allocation kernels: ${report.diagnosis.topAllocation.join(", ")}

Category ratio summaries:

${Object.entries(report.diagnosis.categorySummaries)
	.map(
		([category, summary]) =>
			`- ${category}: ${summary.cases} cases, median ${summary.medianRatio.toFixed(2)}x, range ${summary.minimumRatio.toFixed(2)}x-${summary.maximumRatio.toFixed(2)}x`,
	)
	.join("\n")}

Category summaries describe the selected synthetic cases. They are not percentages of a real workload; representative workload profiles remain authoritative for total-gap attribution.

${failureSection}

${fullCompilerSection}

${categorySections}
`;
}

function gitOutput(args: ReadonlyArray<string>): string {
	return runProcess("git", args).stdout.trim();
}

function sourceIdentity(): {
	readonly commit: string;
	readonly dirty: boolean;
	readonly dirtyDigest: string;
} {
	const commit = gitOutput(["rev-parse", "HEAD"]);
	const patch = gitOutput(["diff", "--binary", "HEAD"]);
	const untracked = gitOutput(["ls-files", "--others", "--exclude-standard", "-z"])
		.split("\0")
		.filter(Boolean)
		.sort();
	const hash = createHash("sha256").update(patch);
	for (const file of untracked) {
		const absolute = path.join(REPOSITORY_ROOT, file);
		hash
			.update(`${file}\0`)
			.update(
				lstatSync(absolute).isSymbolicLink()
					? readlinkSync(absolute)
					: readFileSync(absolute),
			);
	}
	return {
		commit,
		dirty: patch.length > 0 || untracked.length > 0,
		dirtyDigest: hash.digest("hex"),
	};
}

function digest(file: string): string {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function buildRuntimeGapCase(
	descriptor: KernelDescriptor,
	outputDirectory: string,
	deadline: number,
	caseTimeoutMs: number,
): Promise<RuntimeGapBuildEvidence> {
	const token = createHash("sha256").update(descriptor.id).digest("hex").slice(0, 8);
	const output = path.join(
		outputDirectory,
		`.runtime-gap-build-${process.pid}-${token}.json`,
	);
	try {
		const completed = await runBoundedProcess(
			process.execPath,
			[
				path.join(REPOSITORY_ROOT, "scripts/runtime-gap-build-worker.ts"),
				"--fixture",
				descriptor.fixturePath,
				"--name",
				`malgap-${token}`,
				"--output",
				output,
			],
			{
				cwd: REPOSITORY_ROOT,
				environment: cleanTestEnvironment(),
				timeoutMs: invocationTimeout(deadline, caseTimeoutMs),
			},
		);
		if (completed.exitCode !== 0) {
			throw new Error(
				`runtime-gap build failed (${completed.exitCode}):\n${completed.stdout}\n${completed.stderr}`,
			);
		}
		const report = JSON.parse(
			readFileSync(output, "utf8"),
		) as Partial<RuntimeGapBuildEvidence>;
		if (
			report.schema !== 1 ||
			typeof report.binaryPath !== "string" ||
			!existsSync(report.binaryPath) ||
			typeof report.buildMs !== "number" ||
			typeof report.compilerArtifactDigest !== "string" ||
			report.programImage === undefined
		) {
			throw new Error("runtime-gap build worker produced an invalid report");
		}
		return report as RuntimeGapBuildEvidence;
	} finally {
		rmSync(output, { force: true });
		rmSync(`${output}.tmp`, { force: true });
	}
}

export async function main(args: ReadonlyArray<string>): Promise<void> {
	const options = parseOptions(args);
	if (options === undefined) return;
	const catalog = loadRuntimeGapCatalog();
	const experiment =
		options.experimentManifest === undefined
			? undefined
			: loadRuntimeGapExperiment(options.experimentManifest);
	if (experiment !== undefined && catalog.cases.some(({ id }) => id === experiment.id)) {
		throw new Error(
			`runtime-gap experiment collides with catalog case: ${experiment.id}`,
		);
	}
	const allDescriptors = [
		...catalog.cases,
		...(experiment === undefined ? [] : [experiment.case]),
	];
	if (allDescriptors.length === 0) throw new Error("runtime-gap catalog has no cases");
	const knownCategories = new Set(allDescriptors.map(({ category }) => category));
	const unknownCategories = [...options.categories].filter(
		(category) => !knownCategories.has(category),
	);
	if (unknownCategories.length > 0) {
		throw new Error(`unknown categories: ${unknownCategories.join(", ")}`);
	}
	if (options.preset === "confirm" && options.cases.size === 0) {
		throw new Error("the confirm preset requires at least one explicit --case");
	}
	const implicitPresetSelection =
		(options.preset === "quick" || options.preset === "survey") &&
		options.suites.size === 0 &&
		options.groups.size === 0 &&
		options.cases.size === 0 &&
		options.categories.size === 0;
	const presetCases =
		options.preset === "quick" ? catalog.presets.quick : catalog.presets.survey;
	const descriptors = allDescriptors.filter(
		(descriptor) =>
			(options.groups.size === 0 || options.groups.has(descriptor.group)) &&
			(options.suites.size === 0 || options.suites.has(descriptor.suite)) &&
			(options.categories.size === 0 || options.categories.has(descriptor.category)) &&
			(options.cases.size === 0 || options.cases.has(descriptor.id)) &&
			(!implicitPresetSelection || presetCases.includes(descriptor.id)),
	);
	const unknownCases = [...options.cases].filter(
		(id) => !descriptors.some((descriptor) => descriptor.id === id),
	);
	if (unknownCases.length > 0)
		throw new Error(`unknown selected kernels: ${unknownCases.join(", ")}`);
	if (experiment !== undefined) {
		for (const control of experiment.case.controls) {
			if (!catalog.cases.some(({ id }) => id === control)) {
				throw new Error(`${experiment.id} names unknown control: ${control}`);
			}
		}
	}
	if (descriptors.length === 0) throw new Error("no runtime-gap cases selected");
	if (options.plan) {
		console.log(
			JSON.stringify(
				{
					schema: 1,
					workload: "performance-gap",
					preset: options.preset ?? null,
					cases: descriptors,
					samples: options.samples,
					targetNodeMs: options.targetNodeMs,
					budgetSeconds: options.budgetSeconds,
					caseTimeoutMs: options.caseTimeoutMs,
					nodeAllocation: !options.skipNodeAllocation,
					writes: false,
					builds: false,
				},
				undefined,
				"\t",
			),
		);
		return;
	}

	const startedAt = performance.now();
	const deadline = startedAt + options.budgetSeconds * 1_000;
	const results: Array<CompilerHostGapKernelResult> = [];
	const failures: Array<RuntimeGapFailure> = [];
	const source = sourceIdentity();
	let preparationMs = 0;
	let fullCompiler: FullCompilerAnalysis | undefined;
	const classifyFailure = (id: string, error: unknown): RuntimeGapFailure => {
		const message = (error instanceof Error ? error.message : String(error)).slice(
			0,
			2_000,
		);
		const status = message.includes("budget exhausted")
			? "budget"
			: message.includes("ETIMEDOUT") || message.includes("timed out")
				? "timeout"
				: message.includes("work differs")
					? "incorrect"
					: "error";
		return { id, status, message };
	};
	const makeReport = (status: string, complete: boolean) => {
		const byGap = [...results].sort((left, right) => right.hostGapMs - left.hostGapMs);
		const byAllocation = [...results].sort(
			(left, right) =>
				(right.maligator.resource?.allocatedBytes ?? 0) -
				(left.maligator.resource?.allocatedBytes ?? 0),
		);
		return {
			schema: 3,
			status,
			complete,
			generatedAt: new Date().toISOString(),
			elapsedMs: performance.now() - startedAt,
			preparationMs,
			source,
			runtime: {
				node: process.version,
				v8: process.versions.v8,
				platform: process.platform,
				arch: process.arch,
				release: os.release(),
				cpu: os.cpus()[0]?.model ?? "unknown",
			},
			configuration: {
				preset: options.preset ?? null,
				samples: options.samples,
				targetNodeMs: options.targetNodeMs,
				budgetSeconds: options.budgetSeconds,
				caseTimeoutMs: options.caseTimeoutMs,
				selectedCases: descriptors.map(({ id }) => id),
				catalog: path.relative(REPOSITORY_ROOT, RUNTIME_GAP_CATALOG),
				catalogDigest: digest(RUNTIME_GAP_CATALOG),
				...(experiment === undefined
					? {}
					: {
							experimentManifest: path.relative(REPOSITORY_ROOT, experiment.path),
							experimentManifestDigest: digest(experiment.path),
						}),
				caseFixtures: Object.fromEntries(
					descriptors.map((descriptor) => [
						descriptor.id,
						{
							path: path.relative(REPOSITORY_ROOT, descriptor.fixturePath),
							digest: digest(descriptor.fixturePath),
						},
					]),
				),
				driver: path.relative(REPOSITORY_ROOT, fileURLToPath(import.meta.url)),
				driverDigest: digest(fileURLToPath(import.meta.url)),
				build: CONFIG,
				...(options.selfCompile === undefined
					? {}
					: {
							selfCompileArtifact: path.relative(REPOSITORY_ROOT, options.selfCompile),
							selfCompileArtifactDigest: digest(options.selfCompile),
						}),
			},
			workParity: {
				operations: true,
				checksums: true,
				reducedHostWork: false,
				completeSelection: complete,
			},
			results,
			failures,
			...(fullCompiler === undefined ? {} : { fullCompiler }),
			diagnosis: {
				topHostGap: byGap.slice(0, 5).map(({ id }) => id),
				topAllocation: byAllocation.slice(0, 5).map(({ id }) => id),
				categorySummaries: summarizeRuntimeGapCategories(results),
			},
		};
	};
	mkdirSync(path.dirname(options.output), { recursive: true });
	mkdirSync(path.dirname(options.markdown), { recursive: true });
	const persist = (status: string, complete: boolean) => {
		const report = makeReport(status, complete);
		writeFileSync(
			`${options.output}.tmp`,
			`${JSON.stringify(report, undefined, "\t")}\n`,
		);
		renameSync(`${options.output}.tmp`, options.output);
		writeFileSync(`${options.markdown}.tmp`, markdownReport(report));
		renameSync(`${options.markdown}.tmp`, options.markdown);
	};
	persist("preparing", false);

	const progress = new CommandProgress("runtime-gap");
	progress.start(`${descriptors.length} kernels · ${options.samples} paired samples`);
	for (const [index, descriptor] of descriptors.entries()) {
		if (performance.now() >= deadline) {
			for (const pending of descriptors.slice(index)) {
				failures.push({
					id: pending.id,
					status: "budget",
					message: "not started before the whole-run deadline",
				});
			}
			break;
		}
		progress.stage(index + 1, descriptors.length, descriptor.id);
		try {
			const build = await buildRuntimeGapCase(
				descriptor,
				path.dirname(options.output),
				deadline,
				options.caseTimeoutMs,
			);
			preparationMs += build.buildMs;
			results.push(measureKernel(build.binaryPath, build, descriptor, options, deadline));
			progress.stagePassed(index + 1, descriptors.length, descriptor.id);
		} catch (error) {
			progress.stageFailed(index + 1, descriptors.length, descriptor.id);
			const failure = classifyFailure(descriptor.id, error);
			failures.push(failure);
			if (failure.status === "budget") {
				for (const pending of descriptors.slice(index + 1)) {
					failures.push({
						id: pending.id,
						status: "budget",
						message: "not started before the whole-run deadline",
					});
				}
				persist("incomplete", false);
				break;
			}
		}
		persist("running", false);
	}
	if (failures.length === 0 && options.selfCompile !== undefined) {
		try {
			fullCompiler = loadFullCompilerAnalysis(
				options.selfCompile,
				new Set(results.map(({ id }) => id)),
			);
			const unmappedTopOwners = fullCompiler.owners.filter(
				(owner) =>
					fullCompiler!.topHostGap.includes(owner.name) &&
					owner.representativeKernels.length === 0,
			);
			if (unmappedTopOwners.length > 0) {
				throw new Error(
					`top compiler owners lack representative kernels: ${unmappedTopOwners.map(({ name }) => name).join(", ")}`,
				);
			}
		} catch (error) {
			fullCompiler = undefined;
			failures.push(classifyFailure("self-compile-attribution", error));
		}
	}
	const complete = failures.length === 0 && results.length === descriptors.length;
	const status = complete
		? "complete"
		: failures.some((failure) => failure.status !== "budget")
			? "failed"
			: "incomplete";
	persist(status, complete);
	const formatter = path.join(REPOSITORY_ROOT, "node_modules/.bin/oxfmt");
	if (existsSync(formatter))
		runProcess(formatter, ["--write", options.output, options.markdown]);
	console.log(`wrote ${path.relative(REPOSITORY_ROOT, options.output)}`);
	console.log(`wrote ${path.relative(REPOSITORY_ROOT, options.markdown)}`);
	if (complete) progress.complete();
	else {
		progress.failed();
		process.exitCode = 2;
	}
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	await main(process.argv.slice(2));
}
