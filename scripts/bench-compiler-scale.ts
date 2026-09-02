import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as inspector from "node:inspector";
import * as os from "node:os";
import * as path from "node:path";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { getHeapStatistics } from "node:v8";
import type {
	CoreInstrumentationMode,
	CoreOptimizationReport,
} from "../src/compiler/core/core-optimization-report.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";
import { emitProgramTranslationUnits } from "../src/compiler/target/emit-program-image.ts";
import { serializeRuntimeImage } from "../src/compiler/target/program-image-codec.ts";
import {
	prepareSelfCompileSource,
	SELF_COMPILE_CONFIG,
} from "./self-compile-workload.ts";

type TierKind = "synthetic" | "real" | "aggregate" | "self-compile" | "command";

interface CompilerScaleTier {
	readonly tier: number;
	readonly id: string;
	readonly kind: TierKind;
	readonly description: string;
	readonly entries?: ReadonlyArray<string>;
	readonly command?: ReadonlyArray<string>;
}

interface CompilerScaleManifest {
	readonly schemaVersion: number;
	readonly description: string;
	readonly syntheticScales: ReadonlyArray<number>;
	readonly tiers: ReadonlyArray<CompilerScaleTier>;
}

interface CompilerScaleCase {
	readonly tier: number;
	readonly id: string;
	readonly description: string;
	readonly entry: string;
	readonly sourceRoot: string;
	readonly sourceDigest: string;
}

interface WorkerRequest {
	readonly benchmarkCase: CompilerScaleCase;
	readonly sequence: ReadonlyArray<CoreInstrumentationMode>;
	readonly discardFirst: boolean;
	readonly profileLast: boolean;
}

interface CompilerScalePhases {
	graphMs: number;
	semanticMs: number;
	constructCoreMs: number;
	optimizeCoreMs: number;
	coreToExecutionMs: number;
	executionToImageMs: number;
	emitMs: number;
	serializeMs: number;
}

interface HeapProfileSummary {
	readonly samplingIntervalBytes: number;
	readonly sampledBytes: number;
	readonly sampledOptimizeCoreBytes: number;
	readonly gcMsDuringOptimize: number;
	readonly gcEventsDuringOptimize: number;
}

interface CompilerScaleSample {
	readonly instrumentation: CoreInstrumentationMode;
	readonly wallMs: number;
	readonly phases: CompilerScalePhases;
	readonly optimizer: Pick<
		CoreOptimizationReport,
		| "input"
		| "output"
		| "stages"
		| "counters"
		| "program"
		| "transforms"
		| "discovery"
		| "plan"
		| "queue"
		| "budget"
	>;
	readonly memory: {
		readonly heapUsedBefore: number;
		readonly heapUsedAfter: number;
		readonly peakManagedHeap: number;
		readonly rssAfter: number;
		readonly peakRss: number;
	};
	readonly output: {
		readonly units: number;
		readonly codeUnits: number;
		readonly digest: string;
		readonly observableChecksum: string;
	};
	readonly profile?: HeapProfileSummary;
}

interface DriverOptions {
	readonly tiers: ReadonlySet<number>;
	readonly warmRuns?: number;
	readonly coldRuns?: number;
	readonly instrumentation: CoreInstrumentationMode;
	readonly compareInstrumentation: boolean;
	readonly profile: boolean;
	readonly includeTestCheck: boolean;
	readonly quick: boolean;
	readonly output: string;
}

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = realpathSync(path.resolve(path.dirname(SCRIPT_PATH), ".."));
const MANIFEST_PATH = path.join(REPOSITORY_ROOT, "bench/compiler-scale-manifest.json");
const DEFAULT_OUTPUT = path.join(REPOSITORY_ROOT, "bench/compiler-scale-baseline.json");
const WORKER_PREFIX = "COMPILER_SCALE_WORKER=";
const HEAP_SAMPLING_INTERVAL = 32_768;

const HELP = `Usage: node scripts/bench-compiler-scale.ts [options]

Runs the permanent 14-tier compiler complexity ladder. By default tiers 1-13 run;
tier 14 requires --include-test-check.

  --list                       print the committed fixture manifest
  --tier N[,N...]              select one or more tiers
  --warm-runs N                override warmed samples per case
  --cold-runs N                override cold samples per case
  --instrumentation MODE       off, counters or full (default: counters)
  --compare-instrumentation    compare off versus counters on every selected tier
  --no-profile                 omit the separate V8 allocation/GC sample
  --include-test-check         include tier 14 (npm run test:check)
  --quick                      one warm and one cold sample per case
  --output PATH                baseline JSON destination

Completed cases are checkpointed beside the output and resumed automatically.
`;

function readManifest(): CompilerScaleManifest {
	const manifest = JSON.parse(
		readFileSync(MANIFEST_PATH, "utf8"),
	) as CompilerScaleManifest;
	if (manifest.schemaVersion !== 1 || manifest.tiers.length !== 14) {
		throw new Error(
			"compiler scale manifest must contain schema v1 and exactly 14 tiers",
		);
	}
	return manifest;
}

function positiveInteger(raw: string | undefined, option: string): number {
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new Error(`${option} requires a positive integer`);
	}
	return value;
}

function parseOptions(
	args: ReadonlyArray<string>,
	manifest: CompilerScaleManifest,
): DriverOptions {
	let selected: Set<number> | undefined;
	let warmRuns: number | undefined;
	let coldRuns: number | undefined;
	let instrumentation: CoreInstrumentationMode = "counters";
	let compareInstrumentation = false;
	let profile = true;
	let includeTestCheck = false;
	let quick = false;
	let output = DEFAULT_OUTPUT;
	for (let index = 0; index < args.length; index++) {
		const option = args[index]!;
		if (option === "--help" || option === "-h") {
			console.log(HELP);
			process.exit(0);
		}
		if (option === "--list") {
			for (const tier of manifest.tiers) {
				console.log(`${tier.tier}\t${tier.id}\t${tier.description}`);
			}
			process.exit(0);
		}
		if (option === "--tier") {
			selected ??= new Set();
			for (const raw of (args[++index] ?? "").split(",")) {
				selected.add(positiveInteger(raw, "--tier"));
			}
		} else if (option === "--warm-runs") {
			warmRuns = positiveInteger(args[++index], option);
		} else if (option === "--cold-runs") {
			coldRuns = positiveInteger(args[++index], option);
		} else if (option === "--instrumentation") {
			const value = args[++index];
			if (value !== "off" && value !== "counters" && value !== "full") {
				throw new Error("--instrumentation requires off, counters or full");
			}
			instrumentation = value;
		} else if (option === "--compare-instrumentation") {
			compareInstrumentation = true;
		} else if (option === "--no-profile") {
			profile = false;
		} else if (option === "--include-test-check") {
			includeTestCheck = true;
		} else if (option === "--quick") {
			quick = true;
		} else if (option === "--output") {
			output = path.resolve(args[++index] ?? "");
		} else {
			throw new Error(`unknown option ${option}\n${HELP}`);
		}
	}
	const tiers =
		selected ??
		new Set(manifest.tiers.map(({ tier }) => tier).filter((tier) => tier < 14));
	for (const tier of tiers) {
		if (!manifest.tiers.some((entry) => entry.tier === tier)) {
			throw new Error(`tier ${tier} is not in the manifest`);
		}
	}
	return {
		tiers,
		...(warmRuns === undefined ? {} : { warmRuns }),
		...(coldRuns === undefined ? {} : { coldRuns }),
		instrumentation,
		compareInstrumentation,
		profile,
		includeTestCheck,
		quick,
		output,
	};
}

function hashBytes(bytes: string | Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function framedDigest(parts: ReadonlyArray<string>, normalizePath: string): string {
	const digest = createHash("sha256");
	for (const raw of parts) {
		const value = raw.split(normalizePath).join("<compiler-scale-source>");
		const bytes = Buffer.from(value);
		const length = Buffer.allocUnsafe(8);
		length.writeBigUInt64BE(BigInt(bytes.length));
		digest.update(length);
		digest.update(bytes);
	}
	return digest.digest("hex");
}

function normalizedBinaryDigest(bytes: Uint8Array, normalizePath: string): string {
	const digest = createHash("sha256");
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const needle = Buffer.from(normalizePath);
	let offset = 0;
	for (;;) {
		const match = buffer.indexOf(needle, offset);
		if (match < 0) break;
		digest.update(buffer.subarray(offset, match));
		digest.update("<compiler-scale-source>");
		offset = match + needle.length;
	}
	digest.update(buffer.subarray(offset));
	return digest.digest("hex");
}

function syntheticSource(id: string, scale: number): string {
	const count = Math.max(1, scale * 12);
	if (id === "local-arithmetic" || id === "straight-line") {
		const lines = Array.from(
			{ length: id === "straight-line" ? count * 20 : count },
			(_, index) => `value = (value + ${index + 3}) * 3 - ${index % 7};`,
		);
		return `let value = 1;\n${lines.join("\n")}\nglobalThis.compilerScaleResult = value;\n`;
	}
	if (id === "cfg-heavy") {
		const bodies = Array.from(
			{ length: count },
			(_, index) => `
			if ((value & ${2 ** (index % 8)}) !== 0) value += ${index + 1};
			else if (value % 3 === 0) value -= ${index + 2};
			else value ^= ${index + 5};`,
		);
		return `function cfg(value) { ${bodies.join("\n")} return value; }
			globalThis.compilerScaleResult = cfg(12345);\n`;
	}
	if (id === "nested-loops") {
		return `function loops(limit) {
			let total = 0;
			for (let outer = 0; outer < limit; outer++) {
				const invariant = outer * 7 + 3;
				for (let inner = 0; inner < ${count}; inner++) total += invariant + inner;
			}
			return total;
		}
		globalThis.compilerScaleResult = loops(${scale + 2});\n`;
	}
	if (id === "memory-provenance") {
		const fields = Array.from(
			{ length: count },
			(_, index) => `p${index}: ${index}`,
		).join(",");
		const reads = Array.from(
			{ length: count },
			(_, index) =>
				`record.p${index} += aliases[${index % 3}].value; total += record.p${index};`,
		).join("\n");
		return `const record = { ${fields} };
			const shared = { value: 2 }; const aliases = [shared, { value: 3 }, shared];
			let total = 0; ${reads}
			globalThis.compilerScaleResult = total;\n`;
	}
	const functions = Array.from({ length: count }, (_, index) => {
		const next = (index + 1) % count;
		return `function f${index}(value) { return value <= 0 ? ${index} : f${next}(value - 1); }`;
	});
	if (id === "exact-scc") {
		return `${functions.join("\n")}\nglobalThis.compilerScaleResult = f0(${count});\n`;
	}
	const names = Array.from({ length: count }, (_, index) => `f${index}`).join(",");
	return `${functions.join("\n")}
		function invokeUnknown(fn, value) { return fn(value); }
		const functions = [${names}];
		const selected = functions[globalThis.compilerScaleIndex || 0];
		globalThis.compilerScaleResult = invokeUnknown(selected, ${scale});
		globalThis.compilerScaleOpaque?.(globalThis.compilerScaleResult);\n`;
}

function prepareCases(
	root: string,
	manifest: CompilerScaleManifest,
): ReadonlyMap<string, CompilerScaleCase> {
	const sourceRoot = path.join(root, "source");
	const selfCompileEntry = prepareSelfCompileSource(sourceRoot);
	const cases = new Map<string, CompilerScaleCase>();
	for (const tier of manifest.tiers) {
		if (tier.kind === "command") continue;
		if (tier.kind === "synthetic") {
			for (const scale of manifest.syntheticScales) {
				const relative = `bench/compiler-scale-${tier.id}-${scale}.mjs`;
				const source = syntheticSource(tier.id, scale);
				writeFileSync(path.join(sourceRoot, relative), source);
				const id = `${tier.id}-${scale}x`;
				cases.set(id, {
					tier: tier.tier,
					id,
					description: `${tier.description} (${scale}x)`,
					entry: path.join(sourceRoot, relative),
					sourceRoot,
					sourceDigest: hashBytes(source),
				});
			}
			continue;
		}
		if (tier.kind === "real") {
			for (const relative of tier.entries ?? []) {
				const id = `${tier.id}-${path.basename(relative, path.extname(relative))}`;
				cases.set(id, {
					tier: tier.tier,
					id,
					description: `${tier.description}: ${relative}`,
					entry: path.join(sourceRoot, relative),
					sourceRoot,
					sourceDigest: hashBytes(readFileSync(path.join(sourceRoot, relative))),
				});
			}
			continue;
		}
		if (tier.kind === "aggregate") {
			const relative = "bench/compiler-scale-core-subtree.mjs";
			const source = (tier.entries ?? [])
				.map((entry) => `import ${JSON.stringify(`../${entry}`)};`)
				.join("\n");
			writeFileSync(path.join(sourceRoot, relative), `${source}\n`);
			cases.set(tier.id, {
				tier: tier.tier,
				id: tier.id,
				description: tier.description,
				entry: path.join(sourceRoot, relative),
				sourceRoot,
				sourceDigest: hashBytes(source),
			});
			continue;
		}
		cases.set(tier.id, {
			tier: tier.tier,
			id: tier.id,
			description: tier.description,
			entry: selfCompileEntry,
			sourceRoot,
			sourceDigest: hashBytes(readFileSync(selfCompileEntry)),
		});
	}
	return cases;
}

function startHeapSampling(session: inspector.Session): Promise<void> {
	return new Promise((resolve, reject) => {
		session.post(
			"HeapProfiler.startSampling",
			{ samplingInterval: HEAP_SAMPLING_INTERVAL },
			(error) => (error === null ? resolve() : reject(error)),
		);
	});
}

function stopHeapSampling(
	session: inspector.Session,
): Promise<inspector.HeapProfiler.SamplingHeapProfile> {
	return new Promise((resolve, reject) => {
		session.post("HeapProfiler.stopSampling", (error, result) =>
			error === null ? resolve(result.profile) : reject(error),
		);
	});
}

function sampledAllocationSummary(
	node: inspector.HeapProfiler.SamplingHeapProfileNode,
	insideOptimizeCore = false,
): { sampledBytes: number; sampledOptimizeCoreBytes: number } {
	const inside = insideOptimizeCore || node.callFrame.functionName === "optimizeCore";
	let sampledBytes = node.selfSize;
	let sampledOptimizeCoreBytes = inside ? node.selfSize : 0;
	for (const child of node.children) {
		const childSummary = sampledAllocationSummary(child, inside);
		sampledBytes += childSummary.sampledBytes;
		sampledOptimizeCoreBytes += childSummary.sampledOptimizeCoreBytes;
	}
	return { sampledBytes, sampledOptimizeCoreBytes };
}

function emptyPhases(): CompilerScalePhases {
	return {
		graphMs: 0,
		semanticMs: 0,
		constructCoreMs: 0,
		optimizeCoreMs: 0,
		coreToExecutionMs: 0,
		executionToImageMs: 0,
		emitMs: 0,
		serializeMs: 0,
	};
}

async function compileSample(
	benchmarkCase: CompilerScaleCase,
	instrumentation: CoreInstrumentationMode,
	profile: boolean,
): Promise<CompilerScaleSample> {
	const phases = emptyPhases();
	let optimizeStart = 0;
	let optimizeEnd = 0;
	let peakManagedHeap = getHeapStatistics().used_heap_size;
	const heapUsedBefore = process.memoryUsage().heapUsed;
	const sampleHeap = (): void => {
		peakManagedHeap = Math.max(peakManagedHeap, getHeapStatistics().used_heap_size);
	};
	const gcEntries: Array<{ startTime: number; duration: number }> = [];
	const gcObserver = new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) {
			gcEntries.push({ startTime: entry.startTime, duration: entry.duration });
		}
	});
	gcObserver.observe({ entryTypes: ["gc"] });
	const session = profile ? new inspector.Session() : undefined;
	if (session !== undefined) {
		session.connect();
		await startHeapSampling(session);
	}
	let report: CoreOptimizationReport | undefined;
	const compilePhaseNames: Record<string, keyof CompilerScalePhases> = {
		graph: "graphMs",
		semantic: "semanticMs",
		"construct core ir": "constructCoreMs",
		"optimize core ir": "optimizeCoreMs",
		"core to execution": "coreToExecutionMs",
		"execution to image": "executionToImageMs",
	};
	const wallStartedAt = performance.now();
	const image = compileEntrypoint(benchmarkCase.entry, {
		stripTypes: (source) => source,
		buildConfig: SELF_COMPILE_CONFIG,
		coreInstrumentation: instrumentation,
		afterCoreOptimization(_program, _context, optimizationReport) {
			report = optimizationReport;
		},
		runPhase(phase, run) {
			const phaseName = compilePhaseNames[phase];
			const startedAt = performance.now();
			if (phase === "optimize core ir") optimizeStart = startedAt;
			try {
				return run();
			} finally {
				const endedAt = performance.now();
				if (phaseName !== undefined) phases[phaseName] += endedAt - startedAt;
				if (phase === "optimize core ir") optimizeEnd = endedAt;
				sampleHeap();
			}
		},
	});
	if (report === undefined) throw new Error("optimizer did not publish its report");
	const emitStartedAt = performance.now();
	const units = emitProgramTranslationUnits(image, { maligatorSurface: true });
	phases.emitMs = performance.now() - emitStartedAt;
	const serializeStartedAt = performance.now();
	const runtimeWire = serializeRuntimeImage(image.runtime, { debugInfo: false });
	phases.serializeMs = performance.now() - serializeStartedAt;
	const wallMs = performance.now() - wallStartedAt;
	const allocationProfile =
		session === undefined ? undefined : await stopHeapSampling(session);
	session?.disconnect();
	await new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
	gcObserver.disconnect();
	const relevantGc = gcEntries.filter(
		(entry) => entry.startTime >= optimizeStart && entry.startTime <= optimizeEnd,
	);
	const allocation =
		allocationProfile === undefined
			? undefined
			: sampledAllocationSummary(allocationProfile.head);
	sampleHeap();
	const memory = process.memoryUsage();
	const resource = process.resourceUsage();
	const normalizedUnits = units.map((source) =>
		source.split(benchmarkCase.sourceRoot).join("<compiler-scale-source>"),
	);
	return {
		instrumentation,
		wallMs,
		phases,
		optimizer: {
			input: report.input,
			output: report.output,
			stages: report.stages,
			counters: report.counters,
			program: report.program,
			transforms: report.transforms,
			discovery: report.discovery,
			plan: report.plan,
			queue: report.queue,
			budget: report.budget,
		},
		memory: {
			heapUsedBefore,
			heapUsedAfter: memory.heapUsed,
			peakManagedHeap,
			rssAfter: memory.rss,
			peakRss: resource.maxRSS * 1024,
		},
		output: {
			units: units.length,
			codeUnits: normalizedUnits.reduce((total, source) => total + source.length, 0),
			digest: framedDigest(normalizedUnits, benchmarkCase.sourceRoot),
			observableChecksum: normalizedBinaryDigest(runtimeWire, benchmarkCase.sourceRoot),
		},
		...(allocation === undefined
			? {}
			: {
					profile: {
						samplingIntervalBytes: HEAP_SAMPLING_INTERVAL,
						...allocation,
						gcMsDuringOptimize: relevantGc.reduce(
							(total, entry) => total + entry.duration,
							0,
						),
						gcEventsDuringOptimize: relevantGc.length,
					},
				}),
	};
}

async function runWorker(requestPath: string): Promise<void> {
	const request = JSON.parse(readFileSync(requestPath, "utf8")) as WorkerRequest;
	if (request.discardFirst) {
		await compileSample(request.benchmarkCase, request.sequence[0] ?? "off", false);
	}
	const samples: Array<CompilerScaleSample> = [];
	for (let index = 0; index < request.sequence.length; index++) {
		samples.push(
			await compileSample(
				request.benchmarkCase,
				request.sequence[index]!,
				request.profileLast && index === request.sequence.length - 1,
			),
		);
	}
	console.log(`${WORKER_PREFIX}${JSON.stringify(samples)}`);
}

function workerSamples(
	request: WorkerRequest,
	requestRoot: string,
): Array<CompilerScaleSample> {
	mkdirSync(requestRoot, { recursive: true });
	const requestPath = path.join(
		requestRoot,
		`${request.benchmarkCase.id}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
	);
	writeFileSync(requestPath, `${JSON.stringify(request)}\n`);
	const processCount = request.sequence.length + (request.discardFirst ? 1 : 0);
	const result = spawnSync(process.execPath, [SCRIPT_PATH, "--worker", requestPath], {
		cwd: REPOSITORY_ROOT,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		timeout: Math.max(900_000, processCount * 240_000),
	});
	if (result.error !== undefined) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`compiler scale worker failed (${String(result.status)}):\n${result.stdout}\n${result.stderr}`,
		);
	}
	const line = result.stdout
		.split("\n")
		.findLast((entry) => entry.startsWith(WORKER_PREFIX));
	if (line === undefined) throw new Error("compiler scale worker emitted no result");
	return JSON.parse(line.slice(WORKER_PREFIX.length)) as Array<CompilerScaleSample>;
}

function median(values: ReadonlyArray<number>): number {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[middle - 1]! + sorted[middle]!) / 2
		: sorted[middle]!;
}

function assertOutputParity(samples: ReadonlyArray<CompilerScaleSample>): void {
	const reference = samples[0]?.output;
	if (reference === undefined) return;
	for (const sample of samples.slice(1)) {
		if (
			sample.output.units !== reference.units ||
			sample.output.codeUnits !== reference.codeUnits ||
			sample.output.digest !== reference.digest ||
			sample.output.observableChecksum !== reference.observableChecksum
		) {
			throw new Error(
				`compiler scale output changed between samples or modes: ${JSON.stringify(reference)} != ${JSON.stringify(sample.output)}`,
			);
		}
	}
}

function sampleSummary(samples: ReadonlyArray<CompilerScaleSample>) {
	return {
		count: samples.length,
		medianWallMs: median(samples.map(({ wallMs }) => wallMs)),
		medianOptimizeCoreMs: median(samples.map(({ phases }) => phases.optimizeCoreMs)),
		minimumWallMs: Math.min(...samples.map(({ wallMs }) => wallMs)),
		maximumWallMs: Math.max(...samples.map(({ wallMs }) => wallMs)),
	};
}

function commandOutput(command: ReadonlyArray<string>) {
	const [executable, ...args] = command;
	if (executable === undefined) throw new Error("empty command tier");
	const startedAt = performance.now();
	const result = spawnSync(executable, args, {
		cwd: REPOSITORY_ROOT,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		timeout: 1_800_000,
	});
	return {
		command,
		wallMs: performance.now() - startedAt,
		status: result.status,
		stdoutDigest: hashBytes(result.stdout),
		stderrDigest: hashBytes(result.stderr),
	};
}

function gitOutput(args: ReadonlyArray<string>): string {
	const result = spawnSync("git", args, { cwd: REPOSITORY_ROOT, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
	return result.stdout.trim();
}

function writeJsonAtomic(destination: string, value: unknown): void {
	mkdirSync(path.dirname(destination), { recursive: true });
	const temporary = `${destination}.tmp-${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify(value, null, "\t")}\n`);
	renameSync(temporary, destination);
}

function runCoordinator(args: ReadonlyArray<string>): void {
	const manifest = readManifest();
	const options = parseOptions(args, manifest);
	const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "mal-compiler-scale-"));
	const requestRoot = path.join(temporaryRoot, "requests");
	const checkpointPath = `${options.output}.partial`;
	const checkpointSignature = hashBytes(
		JSON.stringify({
			commit: gitOutput(["rev-parse", "HEAD"]),
			manifest: hashBytes(readFileSync(MANIFEST_PATH)),
			driver: hashBytes(readFileSync(SCRIPT_PATH)),
			tiers: [...options.tiers],
			warmRuns: options.warmRuns,
			coldRuns: options.coldRuns,
			instrumentation: options.instrumentation,
			compareInstrumentation: options.compareInstrumentation,
			profile: options.profile,
			includeTestCheck: options.includeTestCheck,
			quick: options.quick,
		}),
	);
	const checkpoint = existsSync(checkpointPath)
		? (JSON.parse(readFileSync(checkpointPath, "utf8")) as {
				signature?: string;
				results?: Array<unknown>;
			})
		: undefined;
	const results: Array<unknown> =
		checkpoint?.signature === checkpointSignature ? (checkpoint.results ?? []) : [];
	const completed = new Set(
		results.map((result) => {
			const entry = result as { tier: number; id: string };
			return `${entry.tier}:${entry.id}`;
		}),
	);
	const saveCheckpoint = (): void => {
		writeJsonAtomic(checkpointPath, {
			schemaVersion: 1,
			signature: checkpointSignature,
			results,
		});
	};
	try {
		const warmCases = prepareCases(
			path.join(temporaryRoot, "w000000000000000"),
			manifest,
		);
		let coldSerial = 0;
		for (const tier of manifest.tiers) {
			if (!options.tiers.has(tier.tier)) continue;
			if (tier.kind === "command") {
				const resultKey = `${tier.tier}:${tier.id}`;
				if (!completed.has(resultKey)) {
					results.push(
						options.includeTestCheck
							? {
									tier: tier.tier,
									id: tier.id,
									gate: commandOutput(tier.command ?? []),
								}
							: {
									tier: tier.tier,
									id: tier.id,
									omitted: "requires --include-test-check",
								},
					);
					completed.add(resultKey);
					saveCheckpoint();
				}
				continue;
			}
			const selectedCases = [...warmCases.values()].filter(
				(benchmarkCase) => benchmarkCase.tier === tier.tier,
			);
			for (const benchmarkCase of selectedCases) {
				const resultKey = `${tier.tier}:${benchmarkCase.id}`;
				if (completed.has(resultKey)) continue;
				const warmRuns = options.quick
					? 1
					: (options.warmRuns ?? (tier.tier === 13 ? 5 : 1));
				const coldRuns = options.quick
					? 1
					: (options.coldRuns ?? (tier.tier === 13 ? 3 : 1));
				const compare = options.compareInstrumentation || tier.tier === 13;
				const sequence: Array<CoreInstrumentationMode> = [];
				if (compare) {
					for (let index = 0; index < warmRuns; index++) {
						if (index % 2 === 0) sequence.push("off", "counters");
						else sequence.push("counters", "off");
					}
				} else {
					sequence.push(
						...Array.from({ length: warmRuns }, () => options.instrumentation),
					);
				}
				console.error(
					`[compiler-scale] tier ${tier.tier} ${benchmarkCase.id}: ${sequence.length} warm, ${coldRuns} cold`,
				);
				const warmed = workerSamples(
					{
						benchmarkCase,
						sequence,
						discardFirst: true,
						profileLast: false,
					},
					requestRoot,
				);
				const cold: Array<CompilerScaleSample> = [];
				for (let index = 0; index < coldRuns; index++) {
					const coldDirectory = `c${String(coldSerial++).padStart(15, "0")}`;
					const coldCases = prepareCases(
						path.join(temporaryRoot, coldDirectory),
						manifest,
					);
					cold.push(
						...workerSamples(
							{
								benchmarkCase: coldCases.get(benchmarkCase.id)!,
								sequence: [options.instrumentation],
								discardFirst: false,
								profileLast: false,
							},
							requestRoot,
						),
					);
				}
				const profile = options.profile
					? workerSamples(
							{
								benchmarkCase,
								sequence: [options.instrumentation],
								discardFirst: true,
								profileLast: true,
							},
							requestRoot,
						)[0]
					: undefined;
				assertOutputParity([
					...warmed,
					...cold,
					...(profile === undefined ? [] : [profile]),
				]);
				const warmByMode = Object.fromEntries(
					(["off", "counters", "full"] as const).flatMap((mode) => {
						const samples = warmed.filter((sample) => sample.instrumentation === mode);
						return samples.length === 0 ? [] : [[mode, sampleSummary(samples)]];
					}),
				);
				const offMedian = warmByMode.off?.medianWallMs;
				const countersMedian = warmByMode.counters?.medianWallMs;
				results.push({
					tier: tier.tier,
					id: benchmarkCase.id,
					description: benchmarkCase.description,
					sourceDigest: benchmarkCase.sourceDigest,
					protocol: {
						warmDefinition:
							"one untimed compile then recorded samples in one Node process",
						coldDefinition: "fresh stripped source tree and fresh Node process",
					},
					warm: { samples: warmed, byMode: warmByMode },
					cold: { samples: cold, summary: sampleSummary(cold) },
					...(profile === undefined ? {} : { profile }),
					...(offMedian === undefined || countersMedian === undefined
						? {}
						: {
								counterOverhead: {
									medianRatio: countersMedian / offMedian,
									passesOnePercentGate: countersMedian / offMedian < 1.01,
								},
							}),
				});
				completed.add(resultKey);
				saveCheckpoint();
			}
		}
		const packageJson = JSON.parse(
			readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8"),
		) as { name: string; version: string };
		const dirtyState = gitOutput(["status", "--porcelain=v1", "--untracked-files=no"]);
		const baseline = {
			schemaVersion: 1,
			generatedAt: new Date().toISOString(),
			source: {
				branch: gitOutput(["branch", "--show-current"]),
				commit: gitOutput(["rev-parse", "HEAD"]),
				dirty: dirtyState.length > 0,
				dirtyDigest: hashBytes(dirtyState),
			},
			compiler: packageJson,
			runtime: {
				node: process.version,
				v8: process.versions.v8,
				platform: process.platform,
				arch: process.arch,
				release: os.release(),
				cpu: os.cpus()[0]?.model ?? "unknown",
				logicalCpus: os.cpus().length,
				totalMemory: os.totalmem(),
			},
			configuration: {
				optimizerMode: "full",
				verification: "boundary",
				instrumentation: options.instrumentation,
				selfCompileConfig: SELF_COMPILE_CONFIG,
				selfCompileConfigDigest: hashBytes(JSON.stringify(SELF_COMPILE_CONFIG)),
				heapSamplingIntervalBytes: HEAP_SAMPLING_INTERVAL,
			},
			artifacts: {
				manifest: path.relative(REPOSITORY_ROOT, MANIFEST_PATH),
				manifestDigest: hashBytes(readFileSync(MANIFEST_PATH)),
				driver: path.relative(REPOSITORY_ROOT, SCRIPT_PATH),
				driverDigest: hashBytes(readFileSync(SCRIPT_PATH)),
				packageLockDigest: hashBytes(
					readFileSync(path.join(REPOSITORY_ROOT, "package-lock.json")),
				),
			},
			results,
		};
		writeJsonAtomic(options.output, baseline);
		rmSync(checkpointPath, { force: true });
		console.error(
			`[compiler-scale] wrote ${path.relative(REPOSITORY_ROOT, options.output)}`,
		);
	} finally {
		rmSync(temporaryRoot, { recursive: true, force: true });
	}
}

if (process.argv[2] === "--worker") {
	const requestPath = process.argv[3];
	if (requestPath === undefined) throw new Error("--worker requires a request path");
	await runWorker(requestPath);
} else {
	runCoordinator(process.argv.slice(2));
}
