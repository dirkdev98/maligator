import { execFileSync } from "node:child_process";
import { hash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import * as path from "node:path";
import { runBoundedProcess } from "./performance-process.ts";

interface BinaryIdentity {
	binaryPath: string;
	sha256: string;
	sourceDigest: string;
	toolchain: string;
	target: string;
	config: unknown;
	features: unknown;
	environmentFingerprint: string;
	inputs: Array<{ file: string; sha256: string }>;
	plan: { mode: string };
}

interface Workload {
	name: string;
	binary: string;
	args: Array<string>;
	oracle?: string;
}

const workloads: Array<Workload> = [
	{
		name: "channel-scalar",
		binary: "channels",
		args: ["scalar", "100000"],
		oracle: "channels.mjs",
	},
	{
		name: "channel-clone",
		binary: "channels",
		args: ["clone", "50000"],
		oracle: "channels.mjs",
	},
	{
		name: "channel-transfer",
		binary: "channels",
		args: ["transfer", "20000"],
		oracle: "channels.mjs",
	},
	{
		name: "channel-timers",
		binary: "channels",
		args: ["timers", "100000"],
		oracle: "channels.mjs",
	},
	{
		name: "channel-web",
		binary: "channels",
		args: ["web", "100000"],
		oracle: "channels.mjs",
	},
	...["tinypool", "pool"].flatMap((binary) => [
		...[2, 8].map((workers): Workload => ({
			name: `${binary}-noop-${workers}`,
			binary,
			args: ["noop", String(workers), "512"],
			oracle: "node-tinypool.mjs",
		})),
		...["transfer", "compute", "allocate", "io"].map((mode): Workload => ({
			name: `${binary}-${mode}`,
			binary,
			args: [mode, "2", mode === "compute" ? "6" : mode === "allocate" ? "16" : "8"],
			oracle: "node-tinypool.mjs",
		})),
		...["transfer", "allocate", "io"].map((mode): Workload => ({
			name: `${binary}-${mode}-8`,
			binary,
			args: [mode, "8", mode === "allocate" ? "16" : "8"],
			oracle: "node-tinypool.mjs",
		})),
	]),
	...[4096, 16384].map((live): Workload => ({
		name: `memory-usage-${live}`,
		binary: "memory-usage",
		args: ["1024", String(live)],
		oracle: "memory-usage.mjs",
	})),
	{
		name: "serial-compute",
		binary: "serial",
		args: ["192"],
		oracle: "serial.mjs",
	},
	...["poll", "charge", "balanced"].map((mode): Workload => ({
		name: `gc-${mode}`,
		binary: "gc-process",
		args: [mode, "4", "200000"],
	})),
];

function option(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index < 0 ? undefined : process.argv[index + 1];
}

const selected = option("--cases")?.split(",");
const cases =
	selected === undefined
		? workloads
		: selected.map((name) => {
				const workload = workloads.find((entry) => entry.name === name);
				if (workload === undefined) throw new Error(`Unknown workload ${name}`);
				return workload;
			});
const runs = Number(option("--runs") ?? "3");
const budgetSeconds = Number(option("--budget-seconds") ?? "180");
if (
	!Number.isSafeInteger(runs) ||
	runs < 1 ||
	runs > 9 ||
	!Number.isFinite(budgetSeconds) ||
	budgetSeconds <= 0
)
	throw new Error("Use --runs 1..9 and a positive --budget-seconds");
const plan = {
	cases,
	runs,
	warmupPairs: 1,
	oracleRuns: 1,
	budgetSeconds,
	nativeProfile: "production",
};
if (process.argv.includes("--plan=json")) {
	console.log(JSON.stringify(plan, null, 2));
} else {
	const baselineArg = option("--baseline");
	const candidateArg = option("--candidate");
	if (baselineArg === undefined || candidateArg === undefined)
		throw new Error(
			"Pass --baseline and --candidate directories containing explicit binary identity JSON files",
		);
	const out = path.resolve(
		option("--out") ??
			`.cache/workers-bench/${new Date().toISOString().replaceAll(":", "-")}`,
	);
	mkdirSync(out, { recursive: true });
	const temporary = mkdtempSync(path.join(tmpdir(), "mal-worker-measure-"));
	const started = performance.now();
	const deadline = started + budgetSeconds * 1000;
	const identities = new Map<string, BinaryIdentity>();
	const sourceDigests = new Map<string, string>();
	const runtimeEnvironment = { ...process.env };
	for (const name of Object.keys(runtimeEnvironment)) {
		if (name.startsWith("MAL_")) delete runtimeEnvironment[name];
	}
	runtimeEnvironment.MAL_GC_PROCESS_BUDGET_BYTES = "268435456";
	const records: Array<unknown> = [];
	const summaries: Array<unknown> = [];
	let complete = false;
	function identity(directory: string, binary: string): BinaryIdentity {
		const key = `${directory}/${binary}`;
		let value = identities.get(key);
		if (value !== undefined) return value;
		value = JSON.parse(
			readFileSync(path.join(directory, `${binary}.json`), "utf8"),
		) as BinaryIdentity;
		if (
			value.plan.mode !== "production" ||
			value.sha256 !== hash("sha256", readFileSync(value.binaryPath), "hex")
		)
			throw new Error(`Binary identity mismatch: ${key}`);
		const sourceDigest = sourceDigests.get(directory);
		if (sourceDigest !== undefined && sourceDigest !== value.sourceDigest)
			throw new Error(`Mixed source revisions: ${directory}`);
		sourceDigests.set(directory, value.sourceDigest);
		for (const input of value.inputs) {
			if (
				input.sha256 !==
				hash("sha256", readFileSync(path.resolve("bench/workers", input.file)), "hex")
			)
				throw new Error(`Oracle input changed since binary build: ${input.file}`);
		}
		identities.set(key, value);
		return value;
	}
	function semantic(result: Record<string, unknown>): string {
		return JSON.stringify([
			result.mode,
			result.operations,
			result.checksum,
			result.workers ?? result.threads,
		]);
	}
	async function measure(
		workload: Workload,
		subject: string,
		executable: string,
		args: Array<string>,
		pair: number,
	) {
		const remaining = deadline - performance.now();
		if (remaining <= 0) throw new Error("Benchmark budget exhausted");
		const resourceFile = path.join(temporary, "resources.txt");
		const before = performance.now();
		const invocation = await runBoundedProcess(
			"/usr/bin/time",
			[
				process.platform === "darwin" ? "-l" : "-v",
				"-o",
				resourceFile,
				executable,
				...args,
			],
			{
				environment: runtimeEnvironment,
				timeoutMs: Math.min(30_000, remaining),
			},
		);
		if (invocation.exitCode !== 0 || invocation.stderr !== "")
			throw new Error(
				`${workload.name}/${subject}: exit ${invocation.exitCode}\n${invocation.stdout}\n${invocation.stderr}`,
			);
		const result = JSON.parse(invocation.stdout) as Record<string, unknown>;
		if (typeof result.elapsedMs !== "number" || result.elapsedMs <= 0)
			throw new Error(`Missing measured duration: ${workload.name}/${subject}`);
		const resourceText = readFileSync(resourceFile, "utf8");
		const timing = resourceText.match(
			/([0-9.]+)\s+real\s+([0-9.]+)\s+user\s+([0-9.]+)\s+sys/,
		);
		const user =
			process.platform === "darwin"
				? timing?.[2]
				: resourceText.match(/User time \(seconds\):\s*([0-9.]+)/)?.[1];
		const system =
			process.platform === "darwin"
				? timing?.[3]
				: resourceText.match(/System time \(seconds\):\s*([0-9.]+)/)?.[1];
		const rss = resourceText.match(
			process.platform === "darwin"
				? /([0-9]+)\s+maximum resident set size/
				: /Maximum resident set size \(kbytes\):\s*([0-9]+)/,
		)?.[1];
		if (user === undefined || system === undefined || rss === undefined)
			throw new Error("Resource report omitted CPU or RSS");
		records.push({
			workload: workload.name,
			subject,
			pair,
			executable,
			args,
			result,
			wallMs: performance.now() - before,
			userCpuMs: Number(user) * 1000,
			systemCpuMs: Number(system) * 1000,
			peakRssBytes: Number(rss) * (process.platform === "darwin" ? 1 : 1024),
			resourceText,
		});
		writeFileSync(
			path.join(out, "samples.json"),
			`${JSON.stringify(records, null, 2)}\n`,
		);
		return result;
	}
	try {
		for (const workload of cases) {
			const baseline = identity(path.resolve(baselineArg), workload.binary);
			const candidate = identity(path.resolve(candidateArg), workload.binary);
			for (const field of [
				"toolchain",
				"target",
				"config",
				"features",
				"plan",
				"environmentFingerprint",
				"inputs",
			] as const) {
				if (JSON.stringify(baseline[field]) !== JSON.stringify(candidate[field]))
					throw new Error(`Unmatched ${field}: ${workload.name}`);
			}
			let expected: string | undefined;
			if (workload.oracle !== undefined)
				expected = semantic(
					await measure(
						workload,
						"node",
						process.execPath,
						[path.resolve("bench/workers", workload.oracle), ...workload.args],
						-1,
					),
				);
			const ratios: Array<number> = [];
			for (let pair = 0; pair <= runs; pair++) {
				const order =
					pair % 2 === 0
						? ([
								["baseline", baseline],
								["candidate", candidate],
							] as const)
						: ([
								["candidate", candidate],
								["baseline", baseline],
							] as const);
				const durations = new Map<string, number>();
				for (const [subject, binary] of order) {
					const result = await measure(
						workload,
						subject,
						binary.binaryPath,
						workload.args,
						pair,
					);
					expected ??= semantic(result);
					if (semantic(result) !== expected)
						throw new Error(`Semantic mismatch: ${workload.name}/${subject}`);
					durations.set(subject, result.elapsedMs as number);
				}
				if (pair > 0)
					ratios.push(durations.get("candidate")! / durations.get("baseline")!);
			}
			summaries.push({
				workload: workload.name,
				ratios,
				medianRatio: [...ratios].sort((a, b) => a - b)[Math.floor(ratios.length / 2)],
			});
			console.log(JSON.stringify(summaries.at(-1)));
		}
		complete = true;
	} finally {
		writeFileSync(
			path.join(out, "report.json"),
			`${JSON.stringify(
				{
					plan,
					complete,
					summaries,
					identities: [...identities],
					head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
					patchSha256: hash(
						"sha256",
						execFileSync("git", ["diff", "--binary", "HEAD"]),
						"hex",
					),
					nodeVersion: process.version,
					measurementTools: [
						"scripts/bench-workers.ts",
						"scripts/build-worker-bench.ts",
					].map((file) => ({ file, sha256: hash("sha256", readFileSync(file), "hex") })),
					platform: process.platform,
					cpu: cpus()[0]?.model,
					runtimeOverrides: {
						MAL_GC_PROCESS_BUDGET_BYTES: runtimeEnvironment.MAL_GC_PROCESS_BUDGET_BYTES,
					},
					ambientMaligatorOverrides: "removed",
					elapsedMs: performance.now() - started,
				},
				null,
				2,
			)}\n`,
		);
		rmSync(temporary, { recursive: true, force: true });
		console.log(`Worker benchmark evidence: ${out}`);
	}
}
