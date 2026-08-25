/**
 * Maligator's benchmark contract has three deliberately different families:
 *
 * - javascript: one balanced core-language ES module under the production native
 *   plan across the complete closed/open x compiled/interpreted matrix, plus Node.
 * - http: the closed compiled bare and Express flagship servers versus Node.
 * - self-compile: the closed compiled Maligator compiler versus its Node host.
 *
 * The committed snapshot contains only stable outcome metrics. Mechanism-specific
 * counters and historical microbenchmarks are diagnostics, not baseline lanes.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveBuildConfig } from "../src/build-config.ts";
import type { ResolvedBuildConfig } from "../src/build-config.ts";
import { CommandProgress } from "../src/command-progress.ts";
import {
	buildBackendPairFromOneProgramImage,
	buildNativeBinary,
	HOST_MAIN,
} from "../src/test-harness.ts";
import { persistBenchmarkBaseline, readBenchmarkBaseline } from "./bench-baseline.ts";
import { runBenchmarkComparison, selectChangedBenchmarkLanes } from "./bench-compare.ts";
import {
	formatOhaDuration,
	parseOhaOutput,
	planExpressHttpWorkload,
} from "./bench-http.ts";
import type { ExpressHttpWorkload, OhaMetrics } from "./bench-http.ts";
import {
	digestSelfCompileOutput,
	prepareSelfCompileSource,
	SELF_COMPILE_CONFIG,
} from "./self-compile-workload.ts";

const BASELINE_FILE = "bench/baseline.json";
const JAVASCRIPT_FIXTURE = "bench/javascript.mjs";
const BENCHMARK_SCHEMA = 3;
const JAVASCRIPT_MODES = [
	"closed-compiled",
	"open-compiled",
	"closed-interpreted",
	"open-interpreted",
] as const;
type JavascriptMode = (typeof JAVASCRIPT_MODES)[number];
type JavascriptWorld = "closed" | "open";
type JavascriptBackend = "compiled" | "interpreted";

const progress = new CommandProgress("bench");
const CLOSED_CONFIG = resolveBuildConfig({});
const OPEN_CONFIG = resolveBuildConfig({
	engine: { primordials: "mutable", eval: true, realms: true },
});
const CLOSED_HTTP_CONFIG = resolveBuildConfig({
	surface: { webPlatform: true },
});
const CLOSED_EXPRESS_CONFIG = resolveBuildConfig({
	surface: { node: true, webPlatform: true },
});

interface PhaseOutput {
	checksum: number;
	elapsedMs: number;
}

interface JavascriptOutput {
	workload: string;
	phases: Record<string, PhaseOutput>;
}

interface JavascriptSample {
	wallMs: number;
	phases: Record<string, number>;
	checksums: Record<string, number>;
}

interface JavascriptReferenceMetrics {
	wallMs: number;
	phaseMs: Record<string, number>;
}

interface JavascriptModeMetrics extends JavascriptReferenceMetrics {
	world: JavascriptWorld;
	backend: JavascriptBackend;
	config: {
		primordials: "locked" | "mutable";
		eval: boolean;
		realms: boolean;
	};
	ratio: number;
	balancedRatio: number;
	binaryBytes: number;
	collections: number;
	allocatedMb: number;
	peakLiveKb: number;
	maxPauseMs: number;
	rssMb?: number;
}

interface JavascriptMetrics {
	workload: string;
	runs: number;
	nativeBuild: {
		mode: "production";
		optimizationFlags: ReadonlyArray<string>;
		lto: boolean;
		strip: boolean;
		compiler: string;
		compilerVersion: string;
		target: string;
	};
	phaseChecksums: Record<string, number>;
	node: JavascriptReferenceMetrics;
	modes: Partial<Record<JavascriptMode, JavascriptModeMetrics>>;
}

interface HttpComparisonMetrics {
	malRps: number;
	nodeRps: number;
	ratio: number;
	malP99Ms: number;
	nodeP99Ms: number;
}

interface HttpMetrics {
	world: "closed";
	runs: number;
	bare: HttpComparisonMetrics & { binaryBytes: number };
	express: {
		binaryBytes: number;
		workloads: Record<string, HttpComparisonMetrics>;
	};
}

interface SelfCompilePhases {
	graphMs: number;
	semanticMs: number;
	lowerSemanticMs: number;
	optimizeMs: number;
	regallocMs: number;
	lowerMs: number;
	emitMs: number;
	writeMs: number;
}

interface SelfCompileMetrics {
	world: "closed";
	maligatorMs: number;
	nodeMs: number;
	maligatorPhases: SelfCompilePhases;
	nodePhases: SelfCompilePhases;
	runs: number;
	units: number;
	maligatorCodeUnits: number;
	nodeCodeUnits: number;
	platform: string;
	arch: string;
	nodeVersion: string;
}

interface BenchmarkSnapshot {
	schema: 3;
	javascript?: JavascriptMetrics;
	http?: HttpMetrics;
	selfCompile?: SelfCompileMetrics;
}

function median(values: ReadonlyArray<number>): number {
	if (values.length === 0) throw new Error("median requires at least one value");
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[middle - 1]! + sorted[middle]!) / 2
		: sorted[middle]!;
}

function medianRecord(
	records: ReadonlyArray<Record<string, number>>,
): Record<string, number> {
	const names = Object.keys(records[0] ?? {});
	if (names.length === 0) throw new Error("phase report is empty");
	for (const record of records) {
		if (JSON.stringify(Object.keys(record)) !== JSON.stringify(names)) {
			throw new Error("phase names changed between benchmark samples");
		}
	}
	return Object.fromEntries(
		names.map((name) => [name, median(records.map((record) => record[name]!))]),
	);
}

function geometricMean(values: ReadonlyArray<number>): number {
	if (values.length === 0 || values.some((value) => value <= 0)) {
		throw new Error("balanced ratio requires positive phase timings");
	}
	return Math.exp(
		values.reduce((total, value) => total + Math.log(value), 0) / values.length,
	);
}

function fileBytes(file: string): number {
	return statSync(file).size;
}

function parseGcStat(stderr: string, field: string): number {
	const line = stderr.split("\n").find((value) => value.includes("[gc-stats]"));
	const match = line?.match(new RegExp(`${field}=([0-9.]+)`));
	if (match === undefined || match === null)
		throw new Error(`GC report omitted ${field}`);
	return Number(match[1]);
}

function parseMaxRss(stderr: string): number | undefined {
	const match = stderr.match(/([0-9]+)\s+maximum resident set size/);
	return match === null ? undefined : Number(match[1]);
}

function parseJavascriptOutput(stdout: string, label: string): JavascriptOutput {
	const line = stdout.trim().split("\n").filter(Boolean).at(-1);
	if (line === undefined) throw new Error(`${label} produced no workload report`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		throw new Error(`${label} produced invalid JSON: ${line}`);
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		(parsed as { workload?: unknown }).workload !== "javascript-v1" ||
		typeof (parsed as { phases?: unknown }).phases !== "object" ||
		(parsed as { phases?: unknown }).phases === null
	) {
		throw new Error(`${label} produced an invalid JavaScript workload report`);
	}
	const result = parsed as JavascriptOutput;
	for (const [name, phase] of Object.entries(result.phases)) {
		if (
			typeof phase.checksum !== "number" ||
			!Number.isFinite(phase.checksum) ||
			typeof phase.elapsedMs !== "number" ||
			!Number.isFinite(phase.elapsedMs) ||
			phase.elapsedMs <= 0
		) {
			throw new Error(`${label} produced invalid phase ${name}`);
		}
	}
	return result;
}

function runJavascriptSample(
	command: string,
	args: ReadonlyArray<string>,
	label: string,
): JavascriptSample {
	const startedAt = process.hrtime.bigint();
	const result = spawnSync(command, args, {
		encoding: "utf8",
		maxBuffer: 4 * 1024 * 1024,
	});
	const wallMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
	if (result.error !== undefined) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`${label} failed (${result.status}):\n${result.stdout}\n${result.stderr}`,
		);
	}
	const output = parseJavascriptOutput(result.stdout, label);
	return {
		wallMs,
		phases: Object.fromEntries(
			Object.entries(output.phases).map(([name, phase]) => [name, phase.elapsedMs]),
		),
		checksums: Object.fromEntries(
			Object.entries(output.phases).map(([name, phase]) => [name, phase.checksum]),
		),
	};
}

function assertSameChecksums(
	reference: Record<string, number>,
	actual: Record<string, number>,
	label: string,
): void {
	if (JSON.stringify(actual) !== JSON.stringify(reference)) {
		throw new Error(
			`${label} checksum mismatch: ${JSON.stringify(actual)} != ${JSON.stringify(reference)}`,
		);
	}
}

function worldConfig(config: ResolvedBuildConfig): JavascriptModeMetrics["config"] {
	return {
		primordials: config.engine.primordials,
		eval: config.engine.eval === true,
		realms: config.engine.realms,
	};
}

function modeParts(mode: JavascriptMode): {
	world: JavascriptWorld;
	backend: JavascriptBackend;
} {
	const [world, backend] = mode.split("-") as [JavascriptWorld, JavascriptBackend];
	return { world, backend };
}

function javascriptGcMetrics(
	binary: string,
	label: string,
): Pick<
	JavascriptModeMetrics,
	"collections" | "allocatedMb" | "peakLiveKb" | "maxPauseMs"
> {
	const result = spawnSync(binary, [], {
		env: { ...process.env, MAL_GC_STATS: "1" },
		encoding: "utf8",
		maxBuffer: 4 * 1024 * 1024,
	});
	if (result.error !== undefined) throw result.error;
	if (result.status !== 0) {
		throw new Error(`${label} GC probe failed (${result.status}):\n${result.stderr}`);
	}
	parseJavascriptOutput(result.stdout, `${label} GC probe`);
	return {
		collections: parseGcStat(result.stderr, "collections"),
		allocatedMb: parseGcStat(result.stderr, "allocated_bytes") / (1024 * 1024),
		peakLiveKb: parseGcStat(result.stderr, "peak_live_bytes") / 1024,
		maxPauseMs: parseGcStat(result.stderr, "max_pause_ms"),
	};
}

function javascriptRssMb(binary: string): number | undefined {
	if (process.platform !== "darwin") return undefined;
	const result = spawnSync("/usr/bin/time", ["-l", binary], {
		encoding: "utf8",
		stdio: ["ignore", "ignore", "pipe"],
	});
	if (result.status !== 0)
		throw new Error(`RSS probe failed for ${binary}: ${result.stderr}`);
	const bytes = parseMaxRss(result.stderr);
	return bytes === undefined ? undefined : bytes / (1024 * 1024);
}

function benchJavascript(
	runs: number,
	selectedModes: ReadonlyArray<JavascriptMode>,
): JavascriptMetrics {
	const binaries: Partial<Record<JavascriptMode, string>> = {};
	let nativeBuildContext:
		| ReturnType<typeof buildBackendPairFromOneProgramImage>["context"]
		| undefined;
	if (selectedModes.some((mode) => mode.startsWith("closed-"))) {
		const closed = buildBackendPairFromOneProgramImage({
			fixture: JAVASCRIPT_FIXTURE,
			name: "bench-javascript-closed",
			config: CLOSED_CONFIG,
			production: true,
		});
		binaries["closed-compiled"] = closed.compiled;
		binaries["closed-interpreted"] = closed.interpreted;
		nativeBuildContext = closed.context;
	}
	if (selectedModes.some((mode) => mode.startsWith("open-"))) {
		const open = buildBackendPairFromOneProgramImage({
			fixture: JAVASCRIPT_FIXTURE,
			name: "bench-javascript-open",
			config: OPEN_CONFIG,
			production: true,
		});
		binaries["open-compiled"] = open.compiled;
		binaries["open-interpreted"] = open.interpreted;
		nativeBuildContext ??= open.context;
	}
	if (nativeBuildContext === undefined) {
		throw new Error("JavaScript benchmark selected no native backend");
	}
	if (nativeBuildContext.plan.mode !== "production") {
		throw new Error("JavaScript benchmark requires a production native build");
	}
	const binaryFor = (mode: JavascriptMode): string => {
		const binary = binaries[mode];
		if (binary === undefined) throw new Error(`JavaScript mode ${mode} was not built`);
		return binary;
	};
	const subjects = [
		{ label: "node", command: process.execPath, args: [JAVASCRIPT_FIXTURE] },
		...selectedModes.map((mode) => ({ label: mode, command: binaryFor(mode), args: [] })),
	];
	const samples = new Map<string, Array<JavascriptSample>>(
		subjects.map(({ label }) => [label, []]),
	);

	progress.detail("javascript warmup");
	const warmReference = runJavascriptSample(
		process.execPath,
		[JAVASCRIPT_FIXTURE],
		"node warmup",
	);
	for (const mode of selectedModes) {
		const warm = runJavascriptSample(binaryFor(mode), [], `${mode} warmup`);
		assertSameChecksums(warmReference.checksums, warm.checksums, `${mode} warmup`);
	}

	for (let sample = 0; sample < runs; sample++) {
		const offset = sample % subjects.length;
		const order = [...subjects.slice(offset), ...subjects.slice(0, offset)];
		for (const subject of order) {
			progress.detail(`javascript sample ${sample + 1}/${runs}: ${subject.label}`);
			const result = runJavascriptSample(subject.command, subject.args, subject.label);
			assertSameChecksums(warmReference.checksums, result.checksums, subject.label);
			samples.get(subject.label)!.push(result);
		}
	}

	const summarize = (label: string): JavascriptReferenceMetrics => {
		const subjectSamples = samples.get(label)!;
		return {
			wallMs: median(subjectSamples.map(({ wallMs }) => wallMs)),
			phaseMs: medianRecord(subjectSamples.map(({ phases }) => phases)),
		};
	};
	const node = summarize("node");
	const modes: Partial<Record<JavascriptMode, JavascriptModeMetrics>> = {};
	for (const mode of selectedModes) {
		const summary = summarize(mode);
		const { world, backend } = modeParts(mode);
		const config = world === "closed" ? CLOSED_CONFIG : OPEN_CONFIG;
		const phaseNames = Object.keys(node.phaseMs);
		const binary = binaryFor(mode);
		const rssMb = javascriptRssMb(binary);
		modes[mode] = {
			...summary,
			world,
			backend,
			config: worldConfig(config),
			ratio: summary.wallMs / node.wallMs,
			balancedRatio: geometricMean(
				phaseNames.map((name) => summary.phaseMs[name]! / node.phaseMs[name]!),
			),
			binaryBytes: fileBytes(binary),
			...javascriptGcMetrics(binary, mode),
			...(rssMb === undefined ? {} : { rssMb }),
		};
	}
	return {
		workload: "javascript-v1",
		runs,
		nativeBuild: {
			mode: "production",
			optimizationFlags: ["-O2", "-g0", ...nativeBuildContext.plan.ltoFlags],
			lto: nativeBuildContext.plan.lto,
			strip: nativeBuildContext.plan.strip,
			compiler: nativeBuildContext.toolchain.tools.cc.path,
			compilerVersion: nativeBuildContext.toolchain.tools.cc.version,
			target: nativeBuildContext.toolchain.rustTarget,
		},
		phaseChecksums: warmReference.checksums,
		node,
		modes,
	};
}

interface SelfCompileRun {
	wallMs: number;
	units: number;
	codeUnits: number;
	digest: string;
	phases: SelfCompilePhases;
}

function runSelfCompile(
	command: string,
	args: Array<string>,
	output: string,
): SelfCompileRun {
	const start = process.hrtime.bigint();
	const result = spawnSync(command, [...args, output], {
		encoding: "utf8",
		maxBuffer: 1024 * 1024,
		timeout: 900_000,
	});
	const wallMs = Number(process.hrtime.bigint() - start) / 1e6;
	if (result.error !== undefined) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`self-compile failed (${result.status}): ${command} ${args.join(" ")}\n${result.stderr}`,
		);
	}
	const summary = JSON.parse(result.stdout.trim()) as {
		units: number;
		codeUnits: number;
		phases: SelfCompilePhases;
	};
	return {
		wallMs,
		units: summary.units,
		codeUnits: summary.codeUnits,
		digest: digestSelfCompileOutput(output),
		phases: summary.phases,
	};
}

function assertSameSelfCompile(reference: SelfCompileRun, actual: SelfCompileRun): void {
	if (
		actual.units !== reference.units ||
		actual.codeUnits !== reference.codeUnits ||
		actual.digest !== reference.digest
	) {
		throw new Error(
			`self-compile output mismatch: ${JSON.stringify(actual)} != ${JSON.stringify(reference)}`,
		);
	}
}

function assertComparableSelfCompile(
	node: SelfCompileRun,
	maligator: SelfCompileRun,
): void {
	const sizeDifference = Math.abs(node.codeUnits - maligator.codeUnits) / node.codeUnits;
	if (node.units !== maligator.units || sizeDifference > 0.01) {
		throw new Error(
			`self-compile workloads diverged: ${JSON.stringify(maligator)} != ${JSON.stringify(node)}`,
		);
	}
}

function medianPhases(values: ReadonlyArray<SelfCompilePhases>): SelfCompilePhases {
	const field = (name: keyof SelfCompilePhases): number =>
		median(values.map((value) => value[name]));
	return {
		graphMs: field("graphMs"),
		semanticMs: field("semanticMs"),
		lowerSemanticMs: field("lowerSemanticMs"),
		optimizeMs: field("optimizeMs"),
		regallocMs: field("regallocMs"),
		lowerMs: field("lowerMs"),
		emitMs: field("emitMs"),
		writeMs: field("writeMs"),
	};
}

function benchSelfCompile(runs: number): SelfCompileMetrics {
	const fixture = path.resolve("bench/self-compile.mts");
	const binary = buildNativeBinary({
		fixture,
		name: "bench-self-compile",
		config: SELF_COMPILE_CONFIG,
	});
	const root = mkdtempSync(path.join(os.tmpdir(), "mal-self-compile-"));
	const maligatorRuns: Array<SelfCompileRun> = [];
	const nodeRuns: Array<SelfCompileRun> = [];
	try {
		const target = prepareSelfCompileSource(path.join(root, "source"));
		for (let index = 0; index < runs; index++) {
			progress.detail(`self-compile paired sample ${index + 1}/${runs}`);
			const nodeOutput = path.join(root, `node-${index}`);
			const maligatorOutput = path.join(root, `maligator-${index}`);
			let node: SelfCompileRun;
			let maligator: SelfCompileRun;
			if (index % 2 === 0) {
				maligator = runSelfCompile(binary, [target], maligatorOutput);
				node = runSelfCompile(process.execPath, [fixture, target], nodeOutput);
			} else {
				node = runSelfCompile(process.execPath, [fixture, target], nodeOutput);
				maligator = runSelfCompile(binary, [target], maligatorOutput);
			}
			assertComparableSelfCompile(node, maligator);
			if (nodeRuns[0] !== undefined) assertSameSelfCompile(nodeRuns[0], node);
			if (maligatorRuns[0] !== undefined)
				assertSameSelfCompile(maligatorRuns[0], maligator);
			nodeRuns.push(node);
			maligatorRuns.push(maligator);
		}
		return {
			world: "closed",
			maligatorMs: median(maligatorRuns.map(({ wallMs }) => wallMs)),
			nodeMs: median(nodeRuns.map(({ wallMs }) => wallMs)),
			maligatorPhases: medianPhases(maligatorRuns.map(({ phases }) => phases)),
			nodePhases: medianPhases(nodeRuns.map(({ phases }) => phases)),
			runs,
			units: nodeRuns[0]!.units,
			maligatorCodeUnits: maligatorRuns[0]!.codeUnits,
			nodeCodeUnits: nodeRuns[0]!.codeUnits,
			platform: process.platform,
			arch: process.arch,
			nodeVersion: process.version,
		};
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function ohaAvailable(): boolean {
	return spawnSync("oha", ["--version"], { stdio: "ignore" }).status === 0;
}

function waitReachable(url: string): void {
	for (let index = 0; index < 100; index++) {
		if (spawnSync("curl", ["-s", "-o", "/dev/null", url]).status === 0) return;
		execFileSync("sleep", ["0.05"]);
	}
	throw new Error(`server never came up: ${url}`);
}

function ohaRun(
	target: string,
	duration: string,
	concurrency: number,
	extraArgs: Array<string> = [],
): OhaMetrics {
	return parseOhaOutput(
		execFileSync(
			"oha",
			[
				"-z",
				duration,
				"-c",
				String(concurrency),
				"--no-tui",
				"--output-format",
				"json",
				"--redirect",
				"0",
				...extraArgs,
				target,
			],
			{ encoding: "utf8", env: { ...process.env, NO_COLOR: "false" } },
		),
	);
}

function compareHttpSamples(
	malTarget: string,
	nodeTarget: string,
	duration: string,
	concurrency: number,
	runs: number,
	extraArgs: Array<string> = [],
): HttpComparisonMetrics {
	const malSamples: Array<OhaMetrics> = [];
	const nodeSamples: Array<OhaMetrics> = [];
	for (let index = 0; index < runs; index++) {
		progress.detail(`HTTP paired sample ${index + 1}/${runs}`);
		if (index % 2 === 0) {
			malSamples.push(ohaRun(malTarget, duration, concurrency, extraArgs));
			nodeSamples.push(ohaRun(nodeTarget, duration, concurrency, extraArgs));
		} else {
			nodeSamples.push(ohaRun(nodeTarget, duration, concurrency, extraArgs));
			malSamples.push(ohaRun(malTarget, duration, concurrency, extraArgs));
		}
	}
	const malRps = median(malSamples.map(({ rps }) => rps));
	const nodeRps = median(nodeSamples.map(({ rps }) => rps));
	return {
		malRps,
		nodeRps,
		ratio: malRps / nodeRps,
		malP99Ms: median(malSamples.map(({ p99Ms }) => p99Ms)),
		nodeP99Ms: median(nodeSamples.map(({ p99Ms }) => p99Ms)),
	};
}

function workloadArgs(
	workload: Pick<ExpressHttpWorkload, "method" | "headers" | "body">,
): Array<string> {
	const args: Array<string> = [];
	if (workload.method !== undefined) args.push("--method", workload.method);
	for (const header of workload.headers ?? []) args.push("-H", header);
	if (workload.body !== undefined) args.push("-d", workload.body);
	return args;
}

function benchHttp(
	runs: number,
	durationSeconds: number,
	concurrency: number,
): HttpMetrics {
	if (!ohaAvailable()) throw new Error("HTTP benchmark requires `oha`");
	const bareBinary = buildNativeBinary({
		fixture: "bench/http/server_mal.js",
		name: "bench-http-bare-closed",
		mainFile: HOST_MAIN,
		config: CLOSED_HTTP_CONFIG,
	});
	const expressBinary = buildNativeBinary({
		fixture: "bench/http/express-server.cjs",
		name: "bench-http-express-closed",
		mainFile: HOST_MAIN,
		config: CLOSED_EXPRESS_CONFIG,
	});
	const bareMal = spawn(bareBinary, [], { stdio: ["ignore", "ignore", "inherit"] });
	const bareNode = spawn(process.execPath, ["bench/http/server_node.js"], {
		stdio: ["ignore", "ignore", "inherit"],
	});
	try {
		waitReachable("http://127.0.0.1:3111/");
		waitReachable("http://127.0.0.1:3112/");
		ohaRun("http://127.0.0.1:3111/", "2s", concurrency);
		ohaRun("http://127.0.0.1:3112/", "2s", concurrency);
		const bare = compareHttpSamples(
			"http://127.0.0.1:3111/",
			"http://127.0.0.1:3112/",
			formatOhaDuration(durationSeconds),
			concurrency,
			runs,
		);
		const expressMal = spawn(expressBinary, [], {
			env: { ...process.env, PORT: "3113" },
			stdio: ["ignore", "ignore", "inherit"],
		});
		const expressNode = spawn(process.execPath, ["bench/http/express-server.cjs"], {
			env: { ...process.env, PORT: "3114" },
			stdio: ["ignore", "ignore", "inherit"],
		});
		const temporary = mkdtempSync(path.join(os.tmpdir(), "mal-bench-http-"));
		try {
			waitReachable("http://127.0.0.1:3113/middleware");
			waitReachable("http://127.0.0.1:3114/middleware");
			ohaRun("http://127.0.0.1:3113/middleware", "2s", concurrency);
			ohaRun("http://127.0.0.1:3114/middleware", "2s", concurrency);
			const workloads: Record<string, HttpComparisonMetrics> = {};
			for (const workload of planExpressHttpWorkload(durationSeconds)) {
				const malUrls = path.join(temporary, `${workload.name}-mal.txt`);
				const nodeUrls = path.join(temporary, `${workload.name}-node.txt`);
				writeFileSync(
					malUrls,
					`${workload.paths.map((value) => `http://127.0.0.1:3113${value}`).join("\n")}\n`,
				);
				writeFileSync(
					nodeUrls,
					`${workload.paths.map((value) => `http://127.0.0.1:3114${value}`).join("\n")}\n`,
				);
				workloads[workload.name] = compareHttpSamples(
					malUrls,
					nodeUrls,
					formatOhaDuration(workload.durationSeconds),
					concurrency,
					runs,
					["--urls-from-file", ...workloadArgs(workload)],
				);
			}
			return {
				world: "closed",
				runs,
				bare: { ...bare, binaryBytes: fileBytes(bareBinary) },
				express: { binaryBytes: fileBytes(expressBinary), workloads },
			};
		} finally {
			expressMal.kill("SIGTERM");
			expressNode.kill("SIGTERM");
			rmSync(temporary, { recursive: true, force: true });
		}
	} finally {
		bareMal.kill("SIGTERM");
		bareNode.kill("SIGTERM");
	}
}

function delta(current: number, previous: number | undefined): string {
	if (previous === undefined || previous === 0) return "";
	const percent = ((current - previous) / Math.abs(previous)) * 100;
	const arrow = percent < 0 ? "↓" : percent === 0 ? "=" : "↑";
	return ` (${percent >= 0 ? "+" : ""}${percent.toFixed(1)}% ${arrow})`;
}

function humanBytes(bytes: number): string {
	return bytes >= 1024 * 1024
		? `${(bytes / (1024 * 1024)).toFixed(1)}MB`
		: `${(bytes / 1024).toFixed(1)}KB`;
}

function reportJavascript(
	current: JavascriptMetrics,
	previous: JavascriptMetrics | undefined,
): void {
	console.log("javascript (balanced core-language matrix):");
	console.log(`  node               ${current.node.wallMs.toFixed(1)}ms`);
	for (const mode of JAVASCRIPT_MODES) {
		const value = current.modes[mode];
		if (value === undefined) continue;
		const prior = previous?.modes[mode];
		console.log(
			`  ${mode.padEnd(19)} ${value.wallMs.toFixed(1)}ms${delta(value.wallMs, prior?.wallMs)}  ${value.ratio.toFixed(2)}x Node  balanced ${value.balancedRatio.toFixed(2)}x`,
		);
		console.log(
			`    ${value.collections} collections, ${value.allocatedMb.toFixed(1)}MB allocated, ${value.peakLiveKb.toFixed(1)}KB peak live, ${value.maxPauseMs.toFixed(3)}ms max pause, ${humanBytes(value.binaryBytes)} binary${value.rssMb === undefined ? "" : `, ${value.rssMb.toFixed(1)}MB RSS`}`,
		);
		console.log(
			`    ${Object.entries(value.phaseMs)
				.map(([name, elapsed]) => `${name} ${elapsed.toFixed(1)}ms`)
				.join(", ")}`,
		);
	}
}

function reportHttp(current: HttpMetrics, previous: HttpMetrics | undefined): void {
	console.log("http (fully closed compiled):");
	console.log(
		`  bare       ${current.bare.malRps.toFixed(0)} req/s${delta(current.bare.malRps, previous?.bare.malRps)} vs Node ${current.bare.nodeRps.toFixed(0)}, p99 ${current.bare.malP99Ms.toFixed(2)}ms, ${humanBytes(current.bare.binaryBytes)}`,
	);
	for (const [name, value] of Object.entries(current.express.workloads)) {
		const prior = previous?.express.workloads[name];
		console.log(
			`  express/${name.padEnd(6)} ${value.malRps.toFixed(0)} req/s${delta(value.malRps, prior?.malRps)} vs Node ${value.nodeRps.toFixed(0)}, p99 ${value.malP99Ms.toFixed(2)}ms`,
		);
	}
	console.log(`  Express binary ${humanBytes(current.express.binaryBytes)}`);
}

function reportSelfCompile(
	current: SelfCompileMetrics,
	previous: SelfCompileMetrics | undefined,
): void {
	console.log("self-compile (fully closed compiled):");
	console.log(
		`  Maligator ${(current.maligatorMs / 1000).toFixed(1)}s${delta(current.maligatorMs, previous?.maligatorMs)} vs Node ${(current.nodeMs / 1000).toFixed(1)}s`,
	);
	console.log(
		`  optimize ${(current.maligatorPhases.optimizeMs / 1000).toFixed(1)}s, emit ${(current.maligatorPhases.emitMs / 1000).toFixed(1)}s, ${current.units} units, ${current.runs} paired samples`,
	);
}

function report(
	current: BenchmarkSnapshot,
	previous: BenchmarkSnapshot | undefined,
): void {
	console.log("\n=== benchmark run ===");
	if (current.javascript !== undefined) {
		reportJavascript(current.javascript, previous?.javascript);
	}
	if (current.http !== undefined) reportHttp(current.http, previous?.http);
	if (current.selfCompile !== undefined) {
		reportSelfCompile(current.selfCompile, previous?.selfCompile);
	}
}

const HELP = `Usage: node scripts/bench.ts [javascript|http|self-compile] [options]

Benchmark families:
  javascript    One balanced ES-module workload under the production native plan
                across closed/open x compiled/interpreted, plus a Node reference.
  http          Fully closed compiled bare HTTP and Express versus Node.
  self-compile  Fully closed compiled Maligator compiler versus its Node host.

Default: javascript and http. --full adds self-compile.

Options:
  --full              Run all three benchmark families
  --mode MODE         Limit javascript to closed-compiled, closed-interpreted,
                      open-compiled, or open-interpreted
  --runs N            Paired/rotated sample count (default: 5)
  --http-seconds N    Total duration per HTTP scenario and subject (default: 5)
  --changed           Select families affected by files changed from a Git ref
  --compare REF       Run paired base/head comparisons against REF
  --max-pairs N       Cap adaptive paired comparison samples
  --json-out PATH     Write the measured snapshot as JSON
  --update            Update selected sections in bench/baseline.json
  -h, --help          Show this help and exit
`;

interface Options {
	update: boolean;
	changed: boolean;
	full: boolean;
	runs: number;
	httpSeconds: number;
	compareRef?: string;
	maxPairs?: number;
	jsonOut?: string;
	mode?: JavascriptMode;
	lanes: Array<string>;
}

function requiredValue(args: Array<string>, index: number, option: string): string {
	const value = args[index + 1];
	if (value === undefined || value.startsWith("-")) {
		throw new Error(`${option} requires a value`);
	}
	return value;
}

function parsePositiveNumber(value: string, option: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`${option} requires a positive number`);
	}
	return parsed;
}

function parseOptions(args: Array<string>): Options | undefined {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(HELP);
		return undefined;
	}
	const options: Options = {
		update: false,
		changed: false,
		full: false,
		runs: 5,
		httpSeconds: 5,
		lanes: [],
	};
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--update") options.update = true;
		else if (arg === "--changed") options.changed = true;
		else if (arg === "--full") options.full = true;
		else if (arg === "--runs") {
			options.runs = parsePositiveNumber(requiredValue(args, index, arg), arg);
			index++;
		} else if (arg === "--http-seconds") {
			options.httpSeconds = parsePositiveNumber(requiredValue(args, index, arg), arg);
			index++;
		} else if (arg === "--compare") {
			options.compareRef = requiredValue(args, index, arg);
			index++;
		} else if (arg === "--max-pairs") {
			options.maxPairs = parsePositiveNumber(requiredValue(args, index, arg), arg);
			index++;
		} else if (arg === "--json-out") {
			options.jsonOut = requiredValue(args, index, arg);
			index++;
		} else if (arg === "--mode") {
			const mode = requiredValue(args, index, arg);
			if (!JAVASCRIPT_MODES.includes(mode as JavascriptMode)) {
				throw new Error(`unknown JavaScript mode: ${mode}`);
			}
			options.mode = mode as JavascriptMode;
			index++;
		} else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
		else options.lanes.push(arg);
	}
	if (!Number.isInteger(options.runs)) throw new Error("--runs must be an integer");
	if (options.maxPairs !== undefined && !Number.isInteger(options.maxPairs)) {
		throw new Error("--max-pairs must be an integer");
	}
	if (options.update && options.compareRef !== undefined) {
		throw new Error("--compare cannot update the committed benchmark baseline");
	}
	if (options.update && options.mode !== undefined) {
		throw new Error("a single --mode cannot replace the complete JavaScript baseline");
	}
	return options;
}

const options = parseOptions(process.argv.slice(2));
if (options === undefined) process.exit(0);

const allLanes = ["javascript", "http", "self-compile"];
const changedSelection = options.changed
	? selectChangedBenchmarkLanes(options.compareRef ?? "HEAD", allLanes)
	: undefined;
const requestedLanes =
	options.lanes.length > 0
		? options.lanes
		: changedSelection !== undefined
			? changedSelection.lanes
			: options.full
				? allLanes
				: ["javascript", "http"];
const unknown = requestedLanes.filter((lane) => !allLanes.includes(lane));
if (unknown.length > 0)
	throw new Error(`unknown benchmark family: ${unknown.join(", ")}`);
if (options.mode !== undefined && !requestedLanes.includes("javascript")) {
	throw new Error("--mode requires the javascript benchmark family");
}
if (changedSelection !== undefined) {
	console.log(
		`changed benchmark selection: ${changedSelection.files.length} files -> ${requestedLanes.length === 0 ? "no families" : requestedLanes.join(", ")}`,
	);
}

if (options.compareRef !== undefined) {
	if (requestedLanes.length === 0) {
		console.log("No benchmark families correspond to the changed files.");
		process.exit(0);
	}
	const comparison = runBenchmarkComparison({
		baseRef: options.compareRef,
		lanes: requestedLanes,
		pairs: options.runs,
		maxPairs: options.maxPairs,
		extraArgs: [
			"--http-seconds",
			String(options.httpSeconds),
			...(options.mode === undefined ? [] : ["--mode", options.mode]),
		],
	});
	process.exit(comparison.exitCode);
}

if (requestedLanes.length === 0) {
	console.log("No benchmark families selected.");
	process.exit(0);
}

const savedBaseline = readBenchmarkBaseline<
	{ schema?: unknown } & Record<string, unknown>
>(BASELINE_FILE);
if (savedBaseline !== undefined && savedBaseline.schema !== BENCHMARK_SCHEMA) {
	throw new Error(
		`benchmark baseline schema ${String(savedBaseline.schema)} is not ${BENCHMARK_SCHEMA}`,
	);
}
const baseline = savedBaseline as BenchmarkSnapshot | undefined;

const entry: BenchmarkSnapshot = { schema: BENCHMARK_SCHEMA };
const implementations: Record<string, () => void> = {
	javascript: () => {
		entry.javascript = benchJavascript(
			options.runs,
			options.mode === undefined ? JAVASCRIPT_MODES : [options.mode],
		);
	},
	http: () => {
		entry.http = benchHttp(options.runs, options.httpSeconds, 50);
	},
	"self-compile": () => {
		entry.selfCompile = benchSelfCompile(options.runs);
	},
};

progress.start(`${requestedLanes.length} families · ${options.runs} samples`);
for (const [index, lane] of requestedLanes.entries()) {
	progress.stage(index + 1, requestedLanes.length, lane);
	try {
		implementations[lane]!();
		progress.stagePassed(index + 1, requestedLanes.length, lane);
	} catch (error) {
		progress.stageFailed(index + 1, requestedLanes.length, lane);
		progress.failed();
		throw error;
	}
}

if (options.jsonOut !== undefined)
	writeFileSync(options.jsonOut, `${JSON.stringify(entry)}\n`);
report(entry, baseline);
persistBenchmarkBaseline(BASELINE_FILE, baseline, entry, options.update);
if (options.update) console.log(`\nUpdated selected sections in ${BASELINE_FILE}.`);
else console.log("\n(run with --update to replace the selected baseline sections)");
progress.complete();
