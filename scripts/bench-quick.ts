import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	copyFileSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	renameSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { MaligatorBuildConfig } from "../src/build-config.ts";
import { createCacheLease } from "../src/cache-management.ts";

type Workload = "compiler-app" | "app-batch";
type Revision = "baseline" | "candidate";
interface Options {
	baseline: string;
	candidate: string;
	workload: Workload;
	pairs: number;
	budgetSeconds: number;
	output: string;
	prepareOnly: boolean;
	prepared?: string;
	plan: boolean;
}
interface Sample {
	label: string;
	revision: Revision;
	wallMs: number;
	peakRssBytes: number;
	digest: string;
}
interface Prepared {
	schema: 1;
	identity: ReturnType<typeof identity>;
	files: Record<string, string>;
	binaries: Record<Revision, string>;
	oracle: string;
	preparationMs: number;
}

const root = path.resolve(import.meta.dirname, "..");
const compilerWorker = path.join(root, "scripts/bench-quick-compiler.ts");
const batchFixture = path.join(root, "bench/quick/app-batch.mts");
const ROWS = 2560;
const ITERATIONS = 200;
const APP_CONFIG = {
	outputName: "app-batch",
	engine: { eval: false, realms: false, intl: { enabled: false } },
	surface: { node: true, webPlatform: false, maligator: false },
} satisfies MaligatorBuildConfig;
const HELP = `Usage: npm run bench:quick -- --baseline CHECKOUT [options]

  --candidate CHECKOUT       candidate source (default: current repository)
  --workload compiler-app|app-batch (default: compiler-app)
  --pairs N                  fixed alternating pairs, 1..15 (default: 3)
  --budget-seconds N         includes preparation, oracle, warmups, and samples (default: 300)
  --output DIRECTORY         new evidence directory (default: .cache/bench-quick/<timestamp>)
  --prepare-only             build reusable app-batch artifacts without measuring
  --prepared DIRECTORY       use matching app-batch preparation
  --plan=json                describe work without writing, building, or acquiring a lease

compiler-app compiles one frozen Express application graph to C using each Node-hosted
compiler directly. app-batch builds production binaries once, then runs a fixed dataset
through parsing, validation, grouping, sorting, and serialization. Both use one warmup
per revision. app-batch requires both revisions to match the Node reference;
compiler-app permits compiler output to change between revisions but requires each
revision to remain deterministic across its samples. Fresh processes are timed end to
end; warmups warm caches, not a persistent JavaScript process.
No native self-hosted compiler, calibration, profiling, or adaptive extra pairs run.
Exit 2 means failed or incomplete. Completed quick runs are screening evidence only.
`;

function options(args: Array<string>): Options | undefined {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(HELP);
		return;
	}
	const value: Options = {
		baseline: "",
		candidate: root,
		workload: "compiler-app",
		pairs: 3,
		budgetSeconds: 300,
		output: path.join(root, ".cache/bench-quick", `${Date.now()}-${process.pid}`),
		prepareOnly: false,
		plan: false,
	};
	while (args.length > 0) {
		const argument = args.shift();
		if (argument === "--plan=json") {
			value.plan = true;
			continue;
		}
		if (argument === "--prepare-only") {
			value.prepareOnly = true;
			continue;
		}
		const next = args.shift();
		if (next === undefined || next.startsWith("--")) throw new Error(HELP);
		if (argument === "--baseline") value.baseline = path.resolve(next);
		else if (argument === "--candidate") value.candidate = path.resolve(next);
		else if (argument === "--output") value.output = path.resolve(next);
		else if (argument === "--prepared") value.prepared = path.resolve(next);
		else if (
			argument === "--workload" &&
			(next === "compiler-app" || next === "app-batch")
		)
			value.workload = next;
		else if (argument === "--pairs") value.pairs = Number(next);
		else if (argument === "--budget-seconds") value.budgetSeconds = Number(next);
		else throw new Error(`unknown option or value: ${argument} ${next}`);
	}
	if (!value.baseline) throw new Error("--baseline CHECKOUT is required");
	if (!Number.isInteger(value.pairs) || value.pairs < 1 || value.pairs > 15)
		throw new Error("--pairs must be 1..15");
	if (
		!Number.isInteger(value.budgetSeconds) ||
		value.budgetSeconds < 1 ||
		value.budgetSeconds > 86400
	)
		throw new Error("--budget-seconds must be 1..86400");
	if (
		(value.prepared !== undefined || value.prepareOnly) &&
		value.workload !== "app-batch"
	)
		throw new Error("reusable preparation requires app-batch");
	if (value.prepared !== undefined && value.prepareOnly)
		throw new Error("--prepared and --prepare-only cannot be combined");
	return value;
}

function digest(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}
function save(file: string, value: unknown): void {
	writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
	renameSync(`${file}.tmp`, file);
}
function command(executable: string, args: Array<string>, cwd?: string): string {
	const result = spawnSync(executable, args, {
		cwd,
		encoding: "utf8",
		timeout: 30_000,
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.error !== undefined) throw result.error;
	if (result.status !== 0)
		throw new Error(`${executable} ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}
function sourceIdentity(directory: string) {
	const git = (...args: Array<string>) => command("git", args, directory);
	const commit = git("rev-parse", "HEAD");
	const hash = createHash("sha256").update(git("rev-parse", "HEAD^{tree}"));
	hash.update(git("diff", "--binary", "HEAD", "--"));
	for (const file of git("ls-files", "--others", "--exclude-standard", "-z")
		.split("\0")
		.filter(Boolean)
		.sort()) {
		const absolute = path.join(directory, file);
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
		digest: hash.digest("hex"),
		lockfile: digest(readFileSync(path.join(directory, "package-lock.json"))),
	};
}
function files(directory: string): Record<string, string> {
	const entries: Record<string, string> = {};
	const visit = (relative: string) => {
		for (const name of readdirSync(path.join(directory, relative)).sort()) {
			if (relative === "" && (name === "manifest.json" || name === "node_modules"))
				continue;
			const file = path.join(relative, name);
			const absolute = path.join(directory, file);
			const stat = lstatSync(absolute);
			if (stat.isDirectory()) visit(file);
			else if (stat.isFile()) entries[file] = digest(readFileSync(absolute));
			else throw new Error(`unexpected non-file in workload or preparation: ${absolute}`);
		}
	};
	visit("");
	return entries;
}
function identity(value: Options) {
	const baseline = sourceIdentity(value.baseline);
	const candidate = sourceIdentity(value.candidate);
	if (baseline.lockfile !== candidate.lockfile)
		throw new Error("baseline and candidate dependency lockfiles differ");
	return {
		workload: value.workload,
		version: 1,
		baseline,
		candidate,
		harness: digest(readFileSync(import.meta.filename)),
		fixture: digest(
			readFileSync(value.workload === "app-batch" ? batchFixture : compilerWorker),
		),
		host: {
			platform: process.platform,
			arch: process.arch,
			node: process.version,
			cpu: os.cpus()[0]?.model,
			parallelism: os.availableParallelism(),
			compiler:
				value.workload === "app-batch"
					? command(process.env.CC ?? "cc", ["--version"])
					: null,
			rust: value.workload === "app-batch" ? command("rustc", ["--version"]) : null,
		},
		build:
			value.workload === "app-batch"
				? "production"
				: "Node-hosted JS-to-C; instrumentation off; no native build",
		work:
			value.workload === "app-batch"
				? { rows: ROWS, iterations: ITERATIONS }
				: { entry: "tests/fixtures/express-5/app.js" },
	};
}

async function run(value: Options): Promise<void> {
	if (existsSync(value.output)) throw new Error(`output already exists: ${value.output}`);
	mkdirSync(value.output, { recursive: true });
	const started = performance.now();
	const deadline = started + value.budgetSeconds * 1000;
	const pairs: Array<{ baseline: Sample; candidate: Sample }> = [];
	const samples: Array<Sample> = [];
	const phases: Record<string, number> = {};
	let complete = false;
	let status = "running";
	let stage = "identity";
	let error: string | undefined;
	let runIdentity: ReturnType<typeof identity> | undefined;
	let prepared: Prepared | undefined;
	let inputDigest: string | undefined;
	let oracle: string | undefined;
	const revisionOracles: Partial<Record<Revision, string>> = {};
	let active: (() => void) | undefined;
	let interruption: string | undefined;
	const median = (values: Array<number>) => {
		const sorted = [...values].sort((a, b) => a - b);
		return (
			(sorted[Math.floor((sorted.length - 1) / 2)]! +
				sorted[Math.floor(sorted.length / 2)]!) /
			2
		);
	};
	const persist = () => {
		const reductions = pairs.map(
			(pair) => 100 * (1 - pair.candidate.wallMs / pair.baseline.wallMs),
		);
		save(path.join(value.output, "report.json"), {
			schema: 1,
			status,
			complete,
			stage,
			error,
			options: value,
			identity: runIdentity,
			inputDigest,
			oracle,
			revisionOracles,
			elapsedMs: performance.now() - started,
			phases,
			samples,
			pairs,
			preparation: {
				reused: value.prepared !== undefined,
				originalCostMs: prepared?.preparationMs,
			},
			cacheState:
				"fresh processes after one warmup per revision; native cache hits remain visible in build logs",
			evidence: value.prepareOnly
				? "preparation only; no performance samples"
				: "screening only; no performance acceptance or baseline update",
			summary:
				pairs.length === 0
					? null
					: {
							pairs: pairs.length,
							baselineMedianMs: median(pairs.map((pair) => pair.baseline.wallMs)),
							candidateMedianMs: median(pairs.map((pair) => pair.candidate.wallMs)),
							medianReductionPercent: median(reductions),
							pairReductionsPercent: reductions,
							rangePercent: [Math.min(...reductions), Math.max(...reductions)],
							preliminary: pairs.length === 1,
						},
		});
	};
	const stop = () => {
		interruption = "interrupted";
		active?.();
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	const checkBudget = () => {
		if (interruption !== undefined) throw new Error(interruption);
		if (performance.now() >= deadline) {
			interruption = "time budget exhausted";
			throw new Error(interruption);
		}
	};
	const execute = async (
		label: string,
		executable: string,
		args: Array<string>,
		cwd: string,
		timed = false,
	) => {
		checkBudget();
		const directory = path.join(value.output, label);
		mkdirSync(directory);
		const stdout = path.join(directory, "stdout.log");
		const stderr = path.join(directory, "stderr.log");
		const out = openSync(stdout, "w");
		const err = openSync(stderr, "w");
		const begin = performance.now();
		console.log(`${label}: ${executable} ${args.join(" ")}`);
		try {
			await new Promise<void>((resolve, reject) => {
				const child = spawn(
					timed ? "/usr/bin/time" : executable,
					timed
						? [process.platform === "darwin" ? "-lp" : "-v", executable, ...args]
						: args,
					{ cwd, stdio: ["ignore", out, err], detached: true },
				);
				const kill = () => {
					if (child.pid !== undefined) {
						try {
							process.kill(-child.pid, "SIGKILL");
						} catch (failure) {
							if ((failure as NodeJS.ErrnoException).code !== "ESRCH") throw failure;
						}
					}
				};
				active = kill;
				const timer = setTimeout(
					() => {
						interruption = "time budget exhausted";
						kill();
					},
					Math.max(1, deadline - performance.now()),
				);
				const done = () => {
					clearTimeout(timer);
					active = undefined;
				};
				child.once("error", (failure) => {
					done();
					reject(failure);
				});
				child.once("close", (code, signal) => {
					done();
					if (interruption !== undefined) reject(new Error(interruption));
					else if (code !== 0)
						reject(new Error(`${label} exited ${code ?? signal}; see ${stderr}`));
					else resolve();
				});
			});
		} finally {
			closeSync(out);
			closeSync(err);
		}
		const wallMs = performance.now() - begin;
		const resource = readFileSync(stderr, "utf8");
		const rss =
			process.platform === "darwin"
				? resource.match(/^\s*(\d+)\s+maximum resident set size\s*$/m)?.[1]
				: resource.match(/Maximum resident set size \(kbytes\):\s*(\d+)/)?.[1];
		if (timed && rss === undefined) throw new Error(`${label} omitted peak RSS`);
		return {
			wallMs,
			peakRssBytes: Number(rss ?? 0) * (process.platform === "linux" ? 1024 : 1),
			stdout,
		};
	};
	const inPhase = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
		stage = name;
		persist();
		const begin = performance.now();
		try {
			return await action();
		} finally {
			phases[name] = performance.now() - begin;
			persist();
		}
	};
	let lease: ReturnType<typeof createCacheLease> | undefined;
	persist();
	try {
		if (process.platform !== "linux" && process.platform !== "darwin")
			throw new Error("quick resource measurements require Linux or macOS");
		lease = createCacheLease("bench-quick");
		runIdentity = identity(value);
		checkBudget();
		const preparation = value.prepared ?? path.join(value.output, "prepared");
		let target = path.join(preparation, "app-batch.mts");
		const input = path.join(preparation, "input.json");
		const binaries: Record<Revision, string> = { baseline: "", candidate: "" };
		await inPhase("preparation", async () => {
			if (value.prepared !== undefined) {
				prepared = JSON.parse(
					readFileSync(path.join(preparation, "manifest.json"), "utf8"),
				) as Prepared;
				if (
					prepared.schema !== 1 ||
					!isDeepStrictEqual(prepared.identity, runIdentity) ||
					!isDeepStrictEqual(prepared.files, files(preparation))
				)
					throw new Error(
						"prepared artifacts, source, workload, dependencies, or host identity do not match",
					);
				Object.assign(binaries, prepared.binaries);
				oracle = prepared.oracle;
			} else {
				mkdirSync(preparation);
				if (value.workload === "compiler-app") {
					const fixture = path.join(value.baseline, "tests/fixtures/express-5");
					cpSync(fixture, path.join(preparation, "express"), {
						recursive: true,
						filter: (file) =>
							path.basename(file) !== "node_modules" && path.basename(file) !== ".cache",
					});
					symlinkSync(
						path.join(value.baseline, "node_modules"),
						path.join(preparation, "node_modules"),
						"dir",
					);
					target = path.join(preparation, "express/app.js");
				} else {
					copyFileSync(batchFixture, target);
					writeFileSync(
						path.join(preparation, "maligator.build.mts"),
						`export default ${JSON.stringify(APP_CONFIG)};\n`,
					);
					writeFileSync(
						input,
						JSON.stringify(
							Array.from({ length: ROWS }, (_, id) => ({
								id,
								region: `region-${id % 7}`,
								category: `category-${(id * 13) % 11}`,
								quantity: (id % 9) + 1,
								price: ((id * 97) % 2000) + 1,
								cancelled: id % 17 === 0,
							})),
						),
					);
					for (const revision of ["baseline", "candidate"] as const) {
						const artifact = path.join(preparation, revision);
						await execute(
							`build-${revision}`,
							process.execPath,
							[
								path.join(value[revision], "src/index.ts"),
								"build",
								target,
								"--production",
								"--config",
								path.join(preparation, "maligator.build.mts"),
								"--artifact",
								artifact,
							],
							value[revision],
						);
						const manifest = JSON.parse(
							readFileSync(path.join(artifact, "artifact.json"), "utf8"),
						) as { name: string; production: boolean };
						if (manifest.production !== true || !/^[A-Za-z0-9_.-]+$/.test(manifest.name))
							throw new Error("expected a production build artifact");
						binaries[revision] = path.join(revision, "bin", manifest.name);
					}
				}
			}
		});
		const frozenFiles = files(preparation);
		inputDigest =
			value.workload === "app-batch"
				? digest(
						JSON.stringify({
							source: digest(readFileSync(target)),
							data: digest(readFileSync(input)),
							iterations: ITERATIONS,
						}),
					)
				: digest(JSON.stringify(frozenFiles));
		const sample = async (label: string, revision: Revision): Promise<Sample> => {
			const output = path.join(value.output, label, "output");
			const measured =
				value.workload === "compiler-app"
					? await execute(
							label,
							process.execPath,
							[compilerWorker, value[revision], target, output],
							value[revision],
							true,
						)
					: await execute(
							label,
							path.join(preparation, binaries[revision]),
							[input, String(ITERATIONS)],
							preparation,
							true,
						);
			return {
				label,
				revision,
				wallMs: measured.wallMs,
				peakRssBytes: measured.peakRssBytes,
				digest:
					value.workload === "compiler-app"
						? digest(JSON.stringify(files(output)))
						: digest(readFileSync(measured.stdout)),
			};
		};
		await inPhase("oracle", async () => {
			if (oracle !== undefined) return;
			if (value.workload === "compiler-app")
				oracle = (await sample("oracle", "baseline")).digest;
			else {
				const reference = await execute(
					"oracle",
					process.execPath,
					[target, input, String(ITERATIONS)],
					preparation,
				);
				const observed = JSON.parse(readFileSync(reference.stdout, "utf8")) as {
					rows: number;
					iterations: number;
					checksum: number;
					summary: Array<unknown>;
				};
				if (
					observed.rows !== ROWS ||
					observed.iterations !== ITERATIONS ||
					!Number.isInteger(observed.checksum) ||
					!Array.isArray(observed.summary) ||
					observed.summary.length === 0
				)
					throw new Error("invalid Node workload oracle");
				oracle = digest(readFileSync(reference.stdout));
			}
		});
		revisionOracles.baseline = oracle!;
		if (value.workload === "app-batch") revisionOracles.candidate = oracle!;
		if (value.workload === "app-batch" && value.prepared === undefined) {
			prepared = {
				schema: 1,
				identity: runIdentity,
				files: files(preparation),
				binaries,
				oracle: oracle!,
				preparationMs: phases.preparation! + phases.oracle!,
			};
			save(path.join(preparation, "manifest.json"), prepared);
		}
		const checked = async (
			label: string,
			revision: Revision,
			establishRevisionOracle = false,
		) => {
			const result = await sample(label, revision);
			samples.push(result);
			if (revisionOracles[revision] === undefined && establishRevisionOracle)
				revisionOracles[revision] = result.digest;
			persist();
			if (result.digest !== revisionOracles[revision])
				throw new Error(
					`${label} output differs from the ${revision} frozen reference; timing is not accepted`,
				);
			return result;
		};
		if (!value.prepareOnly) {
			await inPhase("warmup", async () => {
				await checked("warm-baseline", "baseline");
				await checked("warm-candidate", "candidate", value.workload === "compiler-app");
			});
			await inPhase("measurement", async () => {
				for (let index = 0; index < value.pairs; index++) {
					const order: Array<Revision> =
						index % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
					const results: Partial<Record<Revision, Sample>> = {};
					for (const revision of order)
						results[revision] = await checked(`pair-${index}-${revision}`, revision);
					pairs.push({
						baseline: results.baseline!,
						candidate: results.candidate!,
					});
					persist();
				}
			});
		}
		checkBudget();
		if (!isDeepStrictEqual(runIdentity, identity(value)))
			throw new Error("source or host identity changed during the run");
		if (!isDeepStrictEqual(frozenFiles, files(preparation)))
			throw new Error("workload or prepared artifacts changed during execution");
		complete = true;
		status = "complete";
		stage = "complete";
	} catch (failure) {
		error = failure instanceof Error ? failure.message : String(failure);
		status = interruption === undefined ? "failed" : "incomplete";
		throw failure;
	} finally {
		persist();
		lease?.release();
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
		console.log(`report: ${path.join(value.output, "report.json")}`);
	}
}

if (import.meta.main) {
	try {
		const value = options(process.argv.slice(2));
		if (value?.plan)
			console.log(
				JSON.stringify(
					{
						...value,
						work: [
							value.prepared === undefined
								? value.workload === "compiler-app"
									? "freeze one Express graph; no native compiler build"
									: "freeze dataset and build two production binaries once"
								: "verify matching prepared artifacts",
							"output oracle",
							...(value.prepareOnly
								? []
								: [
										"one warmup per revision",
										`${value.pairs} alternating pairs with output validation`,
									]),
						],
						evidence: "screening only",
						budgetIncludesPreparation: true,
					},
					null,
					2,
				),
			);
		else if (value !== undefined) await run(value);
	} catch (failure) {
		console.error(failure instanceof Error ? failure.message : String(failure));
		process.exitCode = 2;
	}
}
