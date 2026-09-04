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
import { fileURLToPath, pathToFileURL } from "node:url";
import { getHeapStatistics } from "node:v8";
import type {
	CoreInstrumentationMode,
	CoreOptimizationReport,
} from "../src/compiler/core/core-optimization-report.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";
import { emitProgramTranslationUnits } from "../src/compiler/target/emit-program-image.ts";
import { serializeRuntimeImage } from "../src/compiler/target/program-image-codec.ts";
import {
	sampledCompilerAllocationSummary,
	topCompilerProfileHotspots,
} from "./compiler-profile-summary.ts";
import type { CompilerProfileHotspot } from "./compiler-profile-summary.ts";
import { normalizeCompilerScaleMetrics } from "./compiler-scale-normalization.ts";
import {
	prepareSelfCompileSource,
	SELF_COMPILE_CONFIG,
} from "./self-compile-workload.ts";

type TierKind =
	| "synthetic"
	| "real"
	| "aggregate"
	| "self-compile"
	| "paired-self-compile"
	| "command";

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
	readonly sampledOptimizeCoreAttributedBytes: number;
	readonly allocationHotspots: ReadonlyArray<CompilerProfileHotspot>;
	readonly allocationOwnerHotspots: ReadonlyArray<CompilerProfileHotspot>;
	readonly cpuSampledOptimizeMs: number;
	readonly cpuHotspots: ReadonlyArray<CompilerProfileHotspot>;
	readonly gcMsDuringOptimize: number;
	readonly gcEventsDuringOptimize: number;
}

interface CompilerScaleSample {
	readonly instrumentation: CoreInstrumentationMode;
	readonly wallMs: number;
	readonly phases: CompilerScalePhases;
	readonly optimizer: Pick<
		CoreOptimizationReport,
		| "instrumentation"
		| "construction"
		| "input"
		| "output"
		| "phases"
		| "checkpoints"
		| "passes"
		| "analyses"
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
		readonly checkpoints: ReadonlyArray<{
			readonly checkpoint: string;
			readonly heapUsed: number;
			readonly managedHeap: number;
			readonly external: number;
			readonly arrayBuffers: number;
			readonly rss: number;
		}>;
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
	readonly coreOpt3Start: boolean;
	readonly output: string;
}

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = realpathSync(path.resolve(path.dirname(SCRIPT_PATH), ".."));
const REPOSITORY_URL_PREFIX = pathToFileURL(`${REPOSITORY_ROOT}${path.sep}`).href;
const MANIFEST_PATH = path.join(REPOSITORY_ROOT, "bench/compiler-scale-manifest.json");
const DEFAULT_OUTPUT = path.join(REPOSITORY_ROOT, "bench/compiler-scale-baseline.json");
const WORKER_PREFIX = "COMPILER_SCALE_WORKER=";
const HEAP_SAMPLING_INTERVAL = 32_768;

const HELP = `Usage: node scripts/bench-compiler-scale.ts [options]

Runs the permanent 19-tier compiler complexity ladder. By default tiers 1-18 run;
tier 19 requires --include-test-check unless --core-opt3-start selects the complete gate.

  --list                       print the committed fixture manifest
  --tier N[,N...]              select one or more tiers
  --warm-runs N                override warmed samples per case
  --cold-runs N                override cold samples per case
  --instrumentation MODE       off, phases, counters or full (default: counters)
  --compare-instrumentation    compare off, phases and counters on every selected tier
  --no-profile                 omit the separate V8 allocation/GC sample
  --include-test-check         include tier 14 (npm run test:check)
  --quick                      one warm and one cold sample per case
  --core-opt3-start            exact Slice 0 self-compile measurement protocol
  --output PATH                baseline JSON destination

Completed cases are checkpointed beside the output and resumed automatically.
`;

function readManifest(): CompilerScaleManifest {
	const manifest = JSON.parse(
		readFileSync(MANIFEST_PATH, "utf8"),
	) as CompilerScaleManifest;
	if (manifest.schemaVersion !== 1 || manifest.tiers.length !== 19) {
		throw new Error(
			"compiler scale manifest must contain schema v1 and exactly 19 tiers",
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
	let coreOpt3Start = false;
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
			if (
				value !== "off" &&
				value !== "phases" &&
				value !== "counters" &&
				value !== "full"
			) {
				throw new Error("--instrumentation requires off, phases, counters or full");
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
		} else if (option === "--core-opt3-start") {
			coreOpt3Start = true;
		} else if (option === "--output") {
			output = path.resolve(args[++index] ?? "");
		} else {
			throw new Error(`unknown option ${option}\n${HELP}`);
		}
	}
	const tiers =
		selected ??
		new Set(
			manifest.tiers
				.filter(({ kind }) => coreOpt3Start || kind !== "command")
				.map(({ tier }) => tier),
		);
	for (const tier of tiers) {
		if (!manifest.tiers.some((entry) => entry.tier === tier)) {
			throw new Error(`tier ${tier} is not in the manifest`);
		}
	}
	if (
		coreOpt3Start &&
		(quick ||
			warmRuns !== undefined ||
			coldRuns !== undefined ||
			instrumentation !== "counters" ||
			compareInstrumentation ||
			!profile)
	) {
		throw new Error(
			"--core-opt3-start fixes warm, cold, instrumentation, and profile sampling",
		);
	}
	return {
		tiers,
		...(warmRuns === undefined ? {} : { warmRuns }),
		...(coldRuns === undefined ? {} : { coldRuns }),
		instrumentation,
		compareInstrumentation,
		profile,
		includeTestCheck: includeTestCheck || coreOpt3Start,
		quick,
		coreOpt3Start,
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
		const innerLoops = Array.from(
			{ length: count },
			(_, index) => `
				for (let inner${index} = 0; inner${index} < ${index + 3}; inner${index}++) {
					total += invariant + inner${index};
				}`,
		).join("\n");
		return `function loops(limit) {
			let total = 0;
			for (let outer = 0; outer < limit; outer++) {
				const invariant = outer * 7 + 3;
				${innerLoops}
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
		if (tier.kind === "command" || tier.kind === "paired-self-compile") continue;
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

function startCpuSampling(session: inspector.Session): Promise<void> {
	return new Promise((resolve, reject) => {
		session.post("Profiler.enable", (enableError) => {
			if (enableError !== null) {
				reject(enableError);
				return;
			}
			session.post("Profiler.start", (startError) =>
				startError === null ? resolve() : reject(startError),
			);
		});
	});
}

function stopCpuSampling(
	session: inspector.Session,
): Promise<inspector.Profiler.Profile> {
	return new Promise((resolve, reject) => {
		session.post("Profiler.stop", (error, result) =>
			error === null ? resolve(result.profile) : reject(error),
		);
	});
}

function hotspotKey(frame: inspector.Runtime.CallFrame): string {
	return `${frame.functionName}\u0000${frame.url}\u0000${frame.lineNumber}`;
}

function sampledCpuSummary(
	profile: inspector.Profiler.Profile,
	startedAt: number,
	optimizeStart: number,
	optimizeEnd: number,
): {
	cpuSampledOptimizeMs: number;
	cpuHotspots: ReadonlyArray<CompilerProfileHotspot>;
} {
	const nodes = new Map(profile.nodes.map((node) => [node.id, node.callFrame]));
	const weights = new Map<string, number>();
	const frames = new Map<string, inspector.Runtime.CallFrame>();
	const lower = optimizeStart - startedAt;
	const upper = optimizeEnd - startedAt;
	let elapsed = 0;
	let sampled = 0;
	for (let index = 0; index < (profile.samples?.length ?? 0); index++) {
		const delta = (profile.timeDeltas?.[index] ?? 0) / 1_000;
		elapsed += delta;
		if (elapsed < lower || elapsed > upper) continue;
		const frame = nodes.get(profile.samples![index]!);
		if (frame === undefined) continue;
		const key = hotspotKey(frame);
		weights.set(key, (weights.get(key) ?? 0) + delta);
		frames.set(key, frame);
		sampled += delta;
	}
	return {
		cpuSampledOptimizeMs: sampled,
		cpuHotspots: topCompilerProfileHotspots(weights, frames),
	};
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
	let peakManagedHeap = 0;
	const memoryCheckpoints: Array<{
		checkpoint: string;
		heapUsed: number;
		managedHeap: number;
		external: number;
		arrayBuffers: number;
		rss: number;
	}> = [];
	const recordMemory = (checkpoint: string): NodeJS.MemoryUsage => {
		const memory = process.memoryUsage();
		const managedHeap = getHeapStatistics().used_heap_size;
		peakManagedHeap = Math.max(peakManagedHeap, managedHeap);
		memoryCheckpoints.push({
			checkpoint,
			heapUsed: memory.heapUsed,
			managedHeap,
			external: memory.external,
			arrayBuffers: memory.arrayBuffers,
			rss: memory.rss,
		});
		return memory;
	};
	const heapUsedBefore = recordMemory("before-compile").heapUsed;
	const gcEntries: Array<{ startTime: number; duration: number }> = [];
	const gcObserver = new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) {
			gcEntries.push({ startTime: entry.startTime, duration: entry.duration });
		}
	});
	gcObserver.observe({ entryTypes: ["gc"] });
	const session = profile ? new inspector.Session() : undefined;
	let cpuStartedAt = 0;
	if (session !== undefined) {
		session.connect();
		await startHeapSampling(session);
		await startCpuSampling(session);
		cpuStartedAt = performance.now();
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
				recordMemory(`after-${phase}`);
			}
		},
	});
	if (report === undefined) throw new Error("optimizer did not publish its report");
	const emitStartedAt = performance.now();
	const units = emitProgramTranslationUnits(image, { maligatorSurface: true });
	phases.emitMs = performance.now() - emitStartedAt;
	recordMemory("after-emit");
	const serializeStartedAt = performance.now();
	const runtimeWire = serializeRuntimeImage(image.runtime, { debugInfo: false });
	phases.serializeMs = performance.now() - serializeStartedAt;
	const wallMs = performance.now() - wallStartedAt;
	const memoryAfterWork = recordMemory("after-serialize");
	const resourceAfterWork = process.resourceUsage();
	const cpuProfile = session === undefined ? undefined : await stopCpuSampling(session);
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
			: sampledCompilerAllocationSummary(allocationProfile.head, REPOSITORY_URL_PREFIX);
	const cpu =
		cpuProfile === undefined
			? undefined
			: sampledCpuSummary(cpuProfile, cpuStartedAt, optimizeStart, optimizeEnd);
	const normalizedUnits = units.map((source) =>
		source.split(benchmarkCase.sourceRoot).join("<compiler-scale-source>"),
	);
	return {
		instrumentation,
		wallMs,
		phases,
		optimizer: {
			instrumentation: report.instrumentation,
			construction: report.construction,
			input: report.input,
			output: report.output,
			phases: report.phases,
			checkpoints: report.checkpoints,
			passes: report.passes,
			analyses: report.analyses,
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
			heapUsedAfter: memoryAfterWork.heapUsed,
			peakManagedHeap,
			rssAfter: memoryAfterWork.rss,
			peakRss: resourceAfterWork.maxRSS * 1024,
			checkpoints: Object.freeze(memoryCheckpoints),
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
						...cpu!,
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
	const result = spawnSync(process.execPath, [SCRIPT_PATH, "--worker", requestPath], {
		cwd: REPOSITORY_ROOT,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		timeout: 600_000,
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

function normalizedMetrics(
	timingSamples: ReadonlyArray<CompilerScaleSample>,
	metricsSample: CompilerScaleSample,
) {
	const timing = sampleSummary(timingSamples);
	const report = metricsSample.optimizer;
	const finalCheckpoint =
		report.checkpoints.findLast(({ checkpoint }) => checkpoint === "after-sealing") ??
		report.checkpoints.at(-1);
	const analysisRecomputations = (analysis: string): number | undefined =>
		report.analyses.find((entry) => entry.analysis === analysis)?.recomputations;
	return normalizeCompilerScaleMetrics({
		medianWallMs: timing.medianWallMs,
		medianOptimizeCoreMs: timing.medianOptimizeCoreMs,
		inputInstructions: report.input.instructions,
		localWorkItems:
			report.instrumentation === "off" ? undefined : report.counters.localRulesConsidered,
		localAppliedEdits:
			report.passes.length === 0
				? undefined
				: report.passes.reduce((total, pass) => total + pass.edits, 0),
		controlFlowRecomputations: analysisRecomputations("control-flow-bundle"),
		liveBlocks: finalCheckpoint?.blocks.live ?? report.output.blocks,
		liveEdges: finalCheckpoint?.terminatorEdges.live,
		localValueKindRecomputations: analysisRecomputations("local-value-kinds"),
		programValueKindFunctionEvaluations:
			report.instrumentation === "off"
				? undefined
				: report.transforms.valueKindFunctionEvaluations,
		liveValues: report.output.values,
		memoryTransfers:
			report.instrumentation === "off" ? undefined : report.counters.memoryTransfers,
		memoryEvents:
			report.instrumentation === "off" ? undefined : report.counters.memoryAccesses,
		programFlowLocalInstructionVisits:
			report.instrumentation === "off"
				? undefined
				: report.counters.programFlowLocalInstructionVisits,
		programFlowTransferRecords:
			report.instrumentation === "off"
				? undefined
				: report.counters.programFlowTransferRecords,
		programFlowSccTransfers:
			report.instrumentation === "off" ? undefined : report.counters.sccTransfers,
		exactCallEdges:
			report.instrumentation === "off" ? undefined : report.program.exactCallEdges,
		programFlowSccs: report.instrumentation === "off" ? undefined : report.program.sccs,
		candidateFunctionsScanned:
			report.instrumentation === "off"
				? undefined
				: report.counters.specializationFunctionsScanned,
		candidatesDiscovered:
			report.instrumentation === "off"
				? undefined
				: report.counters.specializationCandidatesDiscovered,
		admittedFunctions:
			report.instrumentation === "off" ? undefined : report.plan.admittedFunctions,
		sampledAllocatedBytes: metricsSample.profile?.sampledOptimizeCoreBytes,
		liveInstructions: report.output.instructions,
		peakRssBytes: metricsSample.memory.peakRss,
	});
}

function instrumentationRatio(
	reference: ReadonlyArray<CompilerScaleSample>,
	measured: ReadonlyArray<CompilerScaleSample>,
): { readonly medianRatio: number; readonly sampleRatios: ReadonlyArray<number> } {
	if (reference.length === 0 || measured.length === 0) {
		throw new Error("instrumentation ratio requires both sample sets");
	}
	const sampleRatios =
		reference.length === measured.length
			? measured.map((sample, index) => sample.wallMs / reference[index]!.wallMs)
			: [
					median(measured.map(({ wallMs }) => wallMs)) /
						median(reference.map(({ wallMs }) => wallMs)),
				];
	return { medianRatio: median(sampleRatios), sampleRatios };
}

function commandOutput(command: ReadonlyArray<string>) {
	const [executable, ...args] = command;
	if (executable === undefined) throw new Error("empty command tier");
	const startedAt = performance.now();
	const result = spawnSync(executable, args, {
		cwd: REPOSITORY_ROOT,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		timeout: 600_000,
	});
	if (result.error !== undefined) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`${command.join(" ")} failed with status ${String(result.status)}\n${result.stderr}`,
		);
	}
	return {
		command,
		wallMs: performance.now() - startedAt,
		status: result.status,
		stdoutDigest: hashBytes(result.stdout),
		stderrDigest: hashBytes(result.stderr),
	};
}

function pairedSelfCompileOutput(runs: number, output: string) {
	const command = [
		"npm",
		"run",
		"bench",
		"--",
		"self-compile",
		"--runs",
		String(runs),
		"--json-out",
		output,
	];
	const gate = commandOutput(command);
	const snapshot = JSON.parse(readFileSync(output, "utf8")) as {
		readonly source?: unknown;
		readonly selfCompile?: unknown;
	};
	if (snapshot.selfCompile === undefined) {
		throw new Error("paired self-compile benchmark emitted no self-compile metrics");
	}
	return { gate, source: snapshot.source, metrics: snapshot.selfCompile };
}

function syntheticScalingSummary(
	manifest: CompilerScaleManifest,
	results: ReadonlyArray<unknown>,
	selectedTiers: ReadonlySet<number>,
): ReadonlyArray<unknown> {
	type Result = {
		readonly id: string;
		readonly warm: {
			readonly samples: ReadonlyArray<CompilerScaleSample>;
		};
		readonly profile?: CompilerScaleSample;
	};
	const byId = new Map(
		results.map((raw) => {
			const result = raw as Result;
			return [result.id, result] as const;
		}),
	);
	return manifest.tiers
		.filter((tier) => tier.kind === "synthetic" && selectedTiers.has(tier.tier))
		.map((tier) => {
			const samples = manifest.syntheticScales.map((scale) => {
				const result = byId.get(`${tier.id}-${scale}x`);
				if (result === undefined) {
					throw new Error(`missing synthetic scaling result ${tier.id}-${scale}x`);
				}
				const offSamples = result.warm.samples.filter(
					({ instrumentation }) => instrumentation === "off",
				);
				const timingSamples = offSamples.length === 0 ? result.warm.samples : offSamples;
				const metricsSample = [result.profile, ...result.warm.samples].find(
					(sample) => sample !== undefined && sample.optimizer.input.instructions > 0,
				);
				if (timingSamples.length === 0 || metricsSample === undefined) {
					throw new Error(
						`synthetic scaling result ${tier.id}-${scale}x requires timed and instrumented samples`,
					);
				}
				const wallMs = median(timingSamples.map(({ wallMs }) => wallMs));
				const optimizeCoreMs = median(
					timingSamples.map(({ phases }) => phases.optimizeCoreMs),
				);
				return {
					scale,
					wallMs,
					optimizeCoreMs,
					inputInstructions: metricsSample.optimizer.input.instructions,
					outputCodeUnits: metricsSample.output.codeUnits,
				};
			});
			const base = samples[0]!;
			return {
				id: tier.id,
				samples: samples.map((sample) => ({
					...sample,
					normalized: {
						wallMsPerScale: sample.wallMs / sample.scale,
						optimizeCoreMsPerScale: sample.optimizeCoreMs / sample.scale,
						wallMsPerThousandInputInstructions:
							(sample.wallMs * 1_000) / sample.inputInstructions,
						optimizeCoreMsPerThousandInputInstructions:
							(sample.optimizeCoreMs * 1_000) / sample.inputInstructions,
						inputInstructionsPerScale: sample.inputInstructions / sample.scale,
						outputCodeUnitsPerScale: sample.outputCodeUnits / sample.scale,
					},
					relativeTo1x: {
						wall: sample.wallMs / base.wallMs,
						optimizeCore: sample.optimizeCoreMs / base.optimizeCoreMs,
						inputInstructions: sample.inputInstructions / base.inputInstructions,
						outputCodeUnits: sample.outputCodeUnits / base.outputCodeUnits,
					},
				})),
			};
		});
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
	if (
		options.coreOpt3Start &&
		gitOutput(["status", "--porcelain=v1", "--untracked-files=no"]).length > 0
	) {
		throw new Error("--core-opt3-start requires a clean tracked working tree");
	}
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
			coreOpt3Start: options.coreOpt3Start,
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
			if (tier.kind === "paired-self-compile") {
				const resultKey = `${tier.tier}:${tier.id}`;
				if (!completed.has(resultKey)) {
					const runs = options.quick
						? 1
						: options.coreOpt3Start
							? 5
							: (options.warmRuns ?? 1);
					console.error(
						`[compiler-scale] tier ${tier.tier} ${tier.id}: ${runs} paired warm runs`,
					);
					results.push({
						tier: tier.tier,
						id: tier.id,
						description: tier.description,
						...pairedSelfCompileOutput(runs, path.join(temporaryRoot, `${tier.id}.json`)),
					});
					completed.add(resultKey);
					saveCheckpoint();
				}
				continue;
			}
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
				const exactOpt3SelfCompile =
					options.coreOpt3Start && tier.kind === "self-compile";
				const warmRuns = options.quick
					? 1
					: exactOpt3SelfCompile
						? 5
						: (options.warmRuns ?? (tier.kind === "self-compile" ? 5 : 1));
				const coldRuns = options.quick
					? 1
					: exactOpt3SelfCompile
						? 3
						: (options.coldRuns ?? (tier.kind === "self-compile" ? 3 : 1));
				const compare = options.compareInstrumentation;
				const sequence: Array<CoreInstrumentationMode> = [];
				if (exactOpt3SelfCompile) {
					for (let index = 0; index < warmRuns; index++) {
						if (index === Math.floor(warmRuns / 2)) {
							sequence.push("off", "counters", "phases");
						} else if (index % 2 === 0) sequence.push("off", "phases");
						else sequence.push("phases", "off");
					}
				} else if (compare) {
					for (let index = 0; index < warmRuns; index++) {
						if (index % 2 === 0) sequence.push("off", "phases", "counters");
						else sequence.push("counters", "phases", "off");
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
								sequence: [exactOpt3SelfCompile ? "off" : options.instrumentation],
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
								sequence: [exactOpt3SelfCompile ? "full" : options.instrumentation],
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
					(["off", "phases", "counters", "full"] as const).flatMap((mode) => {
						const samples = warmed.filter((sample) => sample.instrumentation === mode);
						return samples.length === 0 ? [] : [[mode, sampleSummary(samples)]];
					}),
				);
				const offSamples = warmed.filter((sample) => sample.instrumentation === "off");
				const phasesSamples = warmed.filter(
					(sample) => sample.instrumentation === "phases",
				);
				const countersSamples = warmed.filter(
					(sample) => sample.instrumentation === "counters",
				);
				const phasesRatio =
					offSamples.length === 0 || phasesSamples.length === 0
						? undefined
						: instrumentationRatio(offSamples, phasesSamples);
				const countersReference =
					exactOpt3SelfCompile && countersSamples.length === 1
						? [offSamples[Math.floor(offSamples.length / 2)]!]
						: offSamples;
				const countersRatio =
					offSamples.length === 0 || countersSamples.length === 0
						? undefined
						: instrumentationRatio(countersReference, countersSamples);
				const metricsSample = [profile, ...warmed].find(
					(sample) => sample !== undefined && sample.optimizer.input.instructions > 0,
				);
				const timingSamples = offSamples.length === 0 ? warmed : offSamples;
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
					...(metricsSample === undefined
						? {}
						: { normalized: normalizedMetrics(timingSamples, metricsSample) }),
					instrumentationOverhead: {
						...(phasesRatio === undefined
							? {}
							: {
									phases: {
										...phasesRatio,
										passesGate: phasesRatio.medianRatio <= 1.01,
									},
								}),
						...(countersRatio === undefined
							? {}
							: {
									counters: {
										...countersRatio,
										passesGate: countersRatio.medianRatio <= 1.08,
									},
								}),
					},
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
				instrumentation: options.coreOpt3Start
					? "core-opt3-start"
					: options.instrumentation,
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
			syntheticScaling: syntheticScalingSummary(manifest, results, options.tiers),
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
