import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBuildConfig } from "../src/build-config.ts";
import { CommandProgress } from "../src/command-progress.ts";
import { buildNativeBinary } from "../src/test-harness.ts";

const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const FIXTURE = path.join(REPOSITORY_ROOT, "bench/compiler-host-gap.mjs");
const DEFAULT_JSON = path.join(REPOSITORY_ROOT, "bench/core-opt4-host-gap-analysis.json");
const DEFAULT_MARKDOWN = path.join(
	REPOSITORY_ROOT,
	"bench/core-opt4-host-gap-analysis.md",
);
const CONFIG = resolveBuildConfig({
	engine: { eval: false, realms: false, regexp: false, intl: { enabled: false } },
	surface: { node: true, webPlatform: false, maligator: true },
});

interface KernelDescriptor {
	readonly id: string;
	readonly group: "primitive" | "algorithm";
	readonly owner: string;
	readonly category: HostGapCategory;
	readonly sourceSeam: string;
}

type HostGapCategory =
	| "runtime-collections-properties"
	| "function-closure-dispatch"
	| "iterators-callbacks"
	| "allocation-gc"
	| "typed-arrays-numeric-loops"
	| "compiler-algorithms"
	| "unattributed-execution";

interface KernelOutput extends KernelDescriptor {
	readonly schema: 1;
	readonly workload: "compiler-host-gap-v1";
	readonly scale: number;
	readonly operations: number;
	readonly checksum: number;
	readonly elapsedMs: number;
	readonly allocatedBytes?: number;
	readonly collections?: number;
}

interface TimedKernelSample {
	readonly elapsedMs: number;
	readonly allocatedBytes?: number;
	readonly collections?: number;
}

interface ResourceSample {
	readonly cpuMs: number;
	readonly peakRssBytes: number;
	readonly sampledAllocatedBytes?: number;
	readonly allocationSamplingIntervalBytes?: number;
	readonly allocatedBytes?: number;
	readonly collections?: number;
	readonly peakLiveBytes?: number;
	readonly maxPauseMs?: number;
}

export interface CompilerHostGapKernelResult extends KernelDescriptor {
	readonly scale: number;
	readonly operations: number;
	readonly checksum: number;
	readonly node: {
		readonly samples: ReadonlyArray<TimedKernelSample>;
		readonly medianMs: number;
		readonly nsPerOperation: number;
		readonly resource: ResourceSample;
	};
	readonly maligator: {
		readonly samples: ReadonlyArray<TimedKernelSample>;
		readonly medianMs: number;
		readonly nsPerOperation: number;
		readonly resource: ResourceSample;
	};
	readonly ratio: number;
	readonly hostGapMs: number;
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
	readonly output: string;
	readonly markdown: string;
	readonly groups: ReadonlySet<KernelDescriptor["group"]>;
	readonly cases: ReadonlySet<string>;
	readonly skipNodeAllocation: boolean;
	readonly selfCompile?: string;
}

const HELP = `Usage: npm run bench:compiler-host-gap -- [options]

Options:
  --samples N                paired timing samples per host (default: 5)
  --target-node-ms N         minimum calibrated Node kernel time (default: 40)
  --group primitive|algorithm
  --case ID                  select a kernel; repeatable
  --output PATH              JSON report path
  --markdown PATH            Markdown report path
  --skip-node-allocation     omit V8 sampled-allocation resource probes
  --self-compile PATH        merge a full self-compile owner artifact
  --no-self-compile          do not merge the default owner artifact
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
	let samples = 5;
	let targetNodeMs = 40;
	let output = DEFAULT_JSON;
	let markdown = DEFAULT_MARKDOWN;
	const groups = new Set<KernelDescriptor["group"]>();
	const cases = new Set<string>();
	let skipNodeAllocation = false;
	let selfCompile: string | undefined = existsSync(
		path.join(REPOSITORY_ROOT, "bench/core-opt4-host-gap-start.json"),
	)
		? path.join(REPOSITORY_ROOT, "bench/core-opt4-host-gap-start.json")
		: undefined;
	for (let index = 0; index < args.length; index++) {
		const option = args[index]!;
		if (option === "--samples") {
			samples = positiveInteger(requiredValue(args, index), option);
			index++;
		} else if (option === "--target-node-ms") {
			targetNodeMs = positiveInteger(requiredValue(args, index), option);
			index++;
		} else if (option === "--output") {
			output = path.resolve(requiredValue(args, index));
			index++;
		} else if (option === "--markdown") {
			markdown = path.resolve(requiredValue(args, index));
			index++;
		} else if (option === "--group") {
			const group = requiredValue(args, index);
			if (group !== "primitive" && group !== "algorithm") {
				throw new Error(`unknown kernel group: ${group}`);
			}
			groups.add(group);
			index++;
		} else if (option === "--case") {
			cases.add(requiredValue(args, index));
			index++;
		} else if (option === "--skip-node-allocation") {
			skipNodeAllocation = true;
		} else if (option === "--self-compile") {
			selfCompile = path.resolve(requiredValue(args, index));
			index++;
		} else if (option === "--no-self-compile") {
			selfCompile = undefined;
		} else {
			throw new Error(`unknown option: ${option}`);
		}
	}
	return {
		samples,
		targetNodeMs,
		output,
		markdown,
		groups,
		cases,
		skipNodeAllocation,
		...(selfCompile === undefined ? {} : { selfCompile }),
	};
}

function runProcess(
	command: string,
	args: ReadonlyArray<string>,
	environment: NodeJS.ProcessEnv = process.env,
): { readonly stdout: string; readonly stderr: string } {
	const completed = spawnSync(command, [...args], {
		env: environment,
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
		timeout: 900_000,
	});
	if (completed.error !== undefined) throw completed.error;
	if (completed.status !== 0) {
		throw new Error(
			`compiler host-gap process failed (${String(completed.status)}): ${command} ${args.join(" ")}\n${completed.stdout}\n${completed.stderr}`,
		);
	}
	return { stdout: String(completed.stdout), stderr: String(completed.stderr) };
}

function parseKernelOutput(stdout: string): KernelOutput {
	const line = stdout.trim().split("\n").filter(Boolean).at(-1);
	if (line === undefined) throw new Error("compiler host-gap kernel produced no output");
	const parsed = JSON.parse(line) as Partial<KernelOutput>;
	if (
		parsed.schema !== 1 ||
		parsed.workload !== "compiler-host-gap-v1" ||
		typeof parsed.id !== "string" ||
		typeof parsed.operations !== "number" ||
		parsed.operations <= 0 ||
		typeof parsed.checksum !== "number" ||
		typeof parsed.elapsedMs !== "number" ||
		parsed.elapsedMs < 0
	) {
		throw new Error(`invalid compiler host-gap kernel output: ${line}`);
	}
	return parsed as KernelOutput;
}

function listKernels(): ReadonlyArray<KernelDescriptor> {
	const completed = runProcess(process.execPath, [FIXTURE, "--list"]);
	const parsed = JSON.parse(completed.stdout.trim()) as ReadonlyArray<KernelDescriptor>;
	if (parsed.length === 0) throw new Error("compiler host-gap fixture has no kernels");
	return parsed;
}

function runKernel(command: string, args: ReadonlyArray<string>): KernelOutput {
	return parseKernelOutput(
		runProcess(command, args, {
			...process.env,
			MAL_GC_STATS: "1",
			MAL_GC_CONTROL: "1",
		}).stdout,
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

function timeInvocation(
	command: string,
	args: ReadonlyArray<string>,
	environment: NodeJS.ProcessEnv,
): {
	readonly output: KernelOutput;
	readonly cpuMs: number;
	readonly peakRssBytes: number;
	readonly stderr: string;
} {
	const timeFlag = process.platform === "darwin" ? "-l" : "-v";
	const completed = runProcess(
		"/usr/bin/time",
		[timeFlag, command, ...args],
		environment,
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
	return { output: parseKernelOutput(completed.stdout), cpuMs, peakRssBytes, stderr };
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
	id: string,
	scale: number,
	sampleAllocation: boolean,
): ResourceSample {
	if (!sampleAllocation) {
		const measured = timeInvocation(
			process.execPath,
			[FIXTURE, id, String(scale)],
			process.env,
		);
		return { cpuMs: measured.cpuMs, peakRssBytes: measured.peakRssBytes };
	}
	const profileRoot = mkdtempSync(path.join(os.tmpdir(), "mal-host-gap-heap-"));
	try {
		const interval = 1_024;
		const measured = timeInvocation(
			process.execPath,
			[
				"--heap-prof",
				`--heap-prof-interval=${interval}`,
				`--heap-prof-dir=${profileRoot}`,
				FIXTURE,
				id,
				String(scale),
			],
			process.env,
		);
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
		return {
			cpuMs: measured.cpuMs,
			peakRssBytes: measured.peakRssBytes,
			sampledAllocatedBytes: profileSelfSize(profile.head),
			allocationSamplingIntervalBytes: interval,
		};
	} finally {
		rmSync(profileRoot, { recursive: true, force: true });
	}
}

function maligatorResourceSample(
	binary: string,
	id: string,
	scale: number,
): ResourceSample {
	const measured = timeInvocation(binary, [id, String(scale)], {
		...process.env,
		MAL_GC_STATS: "1",
		MAL_GC_CONTROL: "1",
	});
	return {
		cpuMs: measured.cpuMs,
		peakRssBytes: measured.peakRssBytes,
		allocatedBytes: measured.output.allocatedBytes,
		collections: measured.output.collections,
		peakLiveBytes: gcStat(measured.stderr, "peak_live_bytes"),
		maxPauseMs: gcStat(measured.stderr, "max_pause_ms"),
	};
}

function assertParity(reference: KernelOutput, actual: KernelOutput): void {
	if (
		reference.id !== actual.id ||
		reference.scale !== actual.scale ||
		reference.operations !== actual.operations ||
		reference.checksum !== actual.checksum
	) {
		throw new Error(
			`kernel work differs between hosts: ${JSON.stringify(reference)} != ${JSON.stringify(actual)}`,
		);
	}
}

function calibrateScale(descriptor: KernelDescriptor, targetNodeMs: number): number {
	let scale = 1;
	for (let attempt = 0; attempt < 3; attempt++) {
		const output = runKernel(process.execPath, [FIXTURE, descriptor.id, String(scale)]);
		if (output.elapsedMs >= targetNodeMs) return scale;
		const multiplier = Math.max(
			2,
			Math.ceil(targetNodeMs / Math.max(1, output.elapsedMs)),
		);
		scale = Math.min(256, scale * multiplier);
	}
	return scale;
}

function timedSample(output: KernelOutput): TimedKernelSample {
	return {
		elapsedMs: output.elapsedMs,
		...(output.allocatedBytes === undefined
			? {}
			: { allocatedBytes: output.allocatedBytes }),
		...(output.collections === undefined ? {} : { collections: output.collections }),
	};
}

function measureKernel(
	binary: string,
	descriptor: KernelDescriptor,
	options: Pick<Options, "samples" | "targetNodeMs" | "skipNodeAllocation">,
): CompilerHostGapKernelResult {
	const scale = calibrateScale(descriptor, options.targetNodeMs);
	const nodeSamples: Array<TimedKernelSample> = [];
	const maligatorSamples: Array<TimedKernelSample> = [];
	let reference: KernelOutput | undefined;
	for (let sample = 0; sample < options.samples; sample++) {
		const runNode = (): KernelOutput =>
			runKernel(process.execPath, [FIXTURE, descriptor.id, String(scale)]);
		const runMaligator = (): KernelOutput =>
			runKernel(binary, [descriptor.id, String(scale)]);
		const ordered = sample % 2 === 0 ? [runNode, runMaligator] : [runMaligator, runNode];
		const first = ordered[0]!();
		const second = ordered[1]!();
		const node = sample % 2 === 0 ? first : second;
		const maligator = sample % 2 === 0 ? second : first;
		reference ??= node;
		assertParity(reference, node);
		assertParity(reference, maligator);
		nodeSamples.push(timedSample(node));
		maligatorSamples.push(timedSample(maligator));
	}
	const nodeMedianMs = median(nodeSamples.map(({ elapsedMs }) => elapsedMs));
	const maligatorMedianMs = median(maligatorSamples.map(({ elapsedMs }) => elapsedMs));
	const operations = reference!.operations;
	return {
		...descriptor,
		scale,
		operations,
		checksum: reference!.checksum,
		node: {
			samples: nodeSamples,
			medianMs: nodeMedianMs,
			nsPerOperation: (nodeMedianMs * 1e6) / operations,
			resource: nodeResourceSample(descriptor.id, scale, !options.skipNodeAllocation),
		},
		maligator: {
			samples: maligatorSamples,
			medianMs: maligatorMedianMs,
			nsPerOperation: (maligatorMedianMs * 1e6) / operations,
			resource: maligatorResourceSample(binary, descriptor.id, scale),
		},
		ratio: maligatorMedianMs / nodeMedianMs,
		hostGapMs: maligatorMedianMs - nodeMedianMs,
	};
}

export function hostGapFractions(
	results: ReadonlyArray<CompilerHostGapKernelResult>,
): Readonly<Record<HostGapCategory, number>> {
	const categories: ReadonlyArray<HostGapCategory> = [
		"runtime-collections-properties",
		"function-closure-dispatch",
		"iterators-callbacks",
		"allocation-gc",
		"typed-arrays-numeric-loops",
		"compiler-algorithms",
		"unattributed-execution",
	];
	const total = results.reduce((sum, item) => sum + Math.max(0, item.hostGapMs), 0);
	return Object.freeze(
		Object.fromEntries(
			categories.map((category) => [
				category,
				total === 0
					? 0
					: results
							.filter((item) => item.category === category)
							.reduce((sum, item) => sum + Math.max(0, item.hostGapMs), 0) / total,
			]),
		) as Record<HostGapCategory, number>,
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
		return "runtime-collections-properties";
	}
	if (name.includes("specialization") || name.includes("cross-call")) {
		return "function-closure-dispatch";
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
		return "typed-arrays-numeric-loops";
	}
	return "compiler-algorithms";
}

function ownerCategoryFractions(
	owners: ReadonlyArray<FullCompilerOwner & { readonly category: HostGapCategory }>,
): Readonly<Record<HostGapCategory, number>> {
	const categories: ReadonlyArray<HostGapCategory> = [
		"runtime-collections-properties",
		"function-closure-dispatch",
		"iterators-callbacks",
		"allocation-gc",
		"typed-arrays-numeric-loops",
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
	return `| ${result.id} | ${result.node.medianMs.toFixed(1)} | ${result.maligator.medianMs.toFixed(1)} | ${result.ratio.toFixed(2)}x | ${result.hostGapMs.toFixed(1)} | ${result.maligator.resource.allocatedBytes?.toLocaleString() ?? "n/a"} |`;
}

function markdownReport(report: {
	readonly source: { readonly commit: string; readonly dirty: boolean };
	readonly results: ReadonlyArray<CompilerHostGapKernelResult>;
	readonly fullCompiler?: FullCompilerAnalysis;
	readonly diagnosis: {
		readonly firstPrimitiveAboveSeven: string | null;
		readonly firstAlgorithmAboveSeven: string | null;
		readonly topHostGap: ReadonlyArray<string>;
		readonly topAllocation: ReadonlyArray<string>;
		readonly categoryFractions: Readonly<Record<HostGapCategory, number>>;
	};
}): string {
	const primitive = report.results.filter(({ group }) => group === "primitive");
	const algorithm = report.results.filter(({ group }) => group === "algorithm");
	const table = (rows: ReadonlyArray<CompilerHostGapKernelResult>): string =>
		[
			"| Kernel | Node ms | Maligator ms | Ratio | Gap ms | Maligator allocated bytes |",
			"| --- | ---: | ---: | ---: | ---: | ---: |",
			...rows.map(row),
		].join("\n");
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
			`| ${owner.name} | ${owner.nodeMs.toFixed(1)} | ${owner.maligatorMs.toFixed(1)} | ${owner.hostRatio?.toFixed(2) ?? "n/a"}x | ${owner.hostGapMs.toFixed(1)} | ${owner.allocatedBytes?.toLocaleString() ?? "n/a"} | ${owner.representativeKernels.join(", ") || "unmapped"} |`,
	)
	.join("\n")}

Associated positive full-compiler owner-gap fractions:

${Object.entries(report.fullCompiler.categoryFractions)
	.map(([category, fraction]) => `- ${category}: ${(fraction * 100).toFixed(1)}%`)
	.join("\n")}

The category association maps measured owner gaps to their representative kernels; it is a ranking model, not a claim that one primitive alone explains an owner's complete cost.
`;
	return `# Core opt4 compiler host-gap analysis

Source: \`${report.source.commit}\`${report.source.dirty ? " with benchmark changes" : ""}

The kernels replay current compiler operation shapes. They are diagnostic evidence, not product baseline lanes. Node allocation is a V8 sampled-allocation estimate; Maligator allocation and collection deltas are exact runtime counters around the measured kernel. CPU and RSS come from an isolated resource probe, separate from the paired timing samples.

## Diagnosis

- First primitive ratio above 7x: ${report.diagnosis.firstPrimitiveAboveSeven ?? "none"}
- First algorithm ratio above 7x: ${report.diagnosis.firstAlgorithmAboveSeven ?? "none"}
- Top host-gap kernels: ${report.diagnosis.topHostGap.join(", ")}
- Top Maligator allocation kernels: ${report.diagnosis.topAllocation.join(", ")}

Modeled positive kernel-gap fractions:

${Object.entries(report.diagnosis.categoryFractions)
	.map(([category, fraction]) => `- ${category}: ${(fraction * 100).toFixed(1)}%`)
	.join("\n")}

These fractions classify the kernel ladder only. Full compiler owner coverage remains authoritative for the total self-host gap.

${fullCompilerSection}

## Primitive kernels

${table(primitive)}

## Algorithm kernels

${table(algorithm)}
`;
}

function gitOutput(args: ReadonlyArray<string>): string {
	return runProcess("git", args).stdout.trim();
}

function digest(file: string): string {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function main(args: ReadonlyArray<string>): void {
	const options = parseOptions(args);
	if (options === undefined) return;
	const descriptors = listKernels().filter(
		(descriptor) =>
			(options.groups.size === 0 || options.groups.has(descriptor.group)) &&
			(options.cases.size === 0 || options.cases.has(descriptor.id)),
	);
	const unknownCases = [...options.cases].filter(
		(id) => !descriptors.some((descriptor) => descriptor.id === id),
	);
	if (unknownCases.length > 0)
		throw new Error(`unknown selected kernels: ${unknownCases.join(", ")}`);
	if (descriptors.length === 0) throw new Error("no compiler host-gap kernels selected");

	const progress = new CommandProgress("compiler-host-gap");
	progress.start(`${descriptors.length} kernels · ${options.samples} paired samples`);
	progress.detail("build shared native kernel runner");
	const binary = buildNativeBinary({
		fixture: FIXTURE,
		name: "bench-compiler-host-gap",
		config: CONFIG,
		production: true,
	});
	const results: Array<CompilerHostGapKernelResult> = [];
	for (const [index, descriptor] of descriptors.entries()) {
		progress.stage(index + 1, descriptors.length, descriptor.id);
		try {
			results.push(measureKernel(binary, descriptor, options));
			progress.stagePassed(index + 1, descriptors.length, descriptor.id);
		} catch (error) {
			progress.stageFailed(index + 1, descriptors.length, descriptor.id);
			progress.failed();
			throw error;
		}
	}
	const byGap = [...results].sort((left, right) => right.hostGapMs - left.hostGapMs);
	const byAllocation = [...results].sort(
		(left, right) =>
			(right.maligator.resource.allocatedBytes ?? 0) -
			(left.maligator.resource.allocatedBytes ?? 0),
	);
	const fullCompiler =
		options.selfCompile === undefined
			? undefined
			: loadFullCompilerAnalysis(
					options.selfCompile,
					new Set(results.map(({ id }) => id)),
				);
	const unmappedTopOwners =
		fullCompiler?.owners.filter(
			(owner) =>
				fullCompiler.topHostGap.includes(owner.name) &&
				owner.representativeKernels.length === 0,
		) ?? [];
	if (unmappedTopOwners.length > 0) {
		throw new Error(
			`top compiler owners lack representative kernels: ${unmappedTopOwners.map(({ name }) => name).join(", ")}`,
		);
	}
	const diagnosis = {
		firstPrimitiveAboveSeven:
			results.find(({ group, ratio }) => group === "primitive" && ratio > 7)?.id ?? null,
		firstAlgorithmAboveSeven:
			results.find(({ group, ratio }) => group === "algorithm" && ratio > 7)?.id ?? null,
		topHostGap: byGap.slice(0, 5).map(({ id }) => id),
		topAllocation: byAllocation.slice(0, 5).map(({ id }) => id),
		categoryFractions: hostGapFractions(results),
	};
	const dirtyPatch = gitOutput(["diff", "--binary", "HEAD"]);
	const report = {
		schema: 2,
		generatedAt: new Date().toISOString(),
		source: {
			commit: gitOutput(["rev-parse", "HEAD"]),
			dirty: dirtyPatch.length > 0,
			dirtyDigest: createHash("sha256").update(dirtyPatch).digest("hex"),
		},
		runtime: {
			node: process.version,
			v8: process.versions.v8,
			platform: process.platform,
			arch: process.arch,
			release: os.release(),
			cpu: os.cpus()[0]?.model ?? "unknown",
		},
		configuration: {
			samples: options.samples,
			targetNodeMs: options.targetNodeMs,
			fixture: path.relative(REPOSITORY_ROOT, FIXTURE),
			fixtureDigest: digest(FIXTURE),
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
		},
		results,
		...(fullCompiler === undefined ? {} : { fullCompiler }),
		diagnosis,
	};
	writeFileSync(options.output, `${JSON.stringify(report, undefined, "\t")}\n`);
	writeFileSync(options.markdown, markdownReport(report));
	const formatter = path.join(REPOSITORY_ROOT, "node_modules/.bin/oxfmt");
	if (existsSync(formatter))
		runProcess(formatter, ["--write", options.output, options.markdown]);
	console.log(`wrote ${path.relative(REPOSITORY_ROOT, options.output)}`);
	console.log(`wrote ${path.relative(REPOSITORY_ROOT, options.markdown)}`);
	progress.complete();
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2));
}
