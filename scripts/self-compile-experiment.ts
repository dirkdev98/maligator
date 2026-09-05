import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readlinkSync,
	readdirSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createCacheLease } from "../src/cache-management.ts";
import {
	digestSelfCompileOutput,
	prepareSelfCompileSource,
	SELF_COMPILE_CONFIG,
} from "./self-compile-workload.ts";

const HELP = `Usage: npm run bench:self-compile-experiment -- <command> [options]

  capture DIRECTORY                 preserve the current native compiler and stripped Node source
  compare BASE CANDIDATE --output DIRECTORY
                                    run both captures on the same frozen BASE input

Options:
  --host native|node                compiler host (default: native)
  --workload parser|shape|full       frozen input cone (default: parser)
  --pairs N                         alternating measured pairs (default: 5)
  --budget-seconds N                total command budget (default: 600)
  --plan=json                       show work without building or writing

Capture uses development O2/no-LTO closed native code without instrumentation.
Compare runs a BASE Node output oracle and one warmup per compiler before timing.
Every output must match that oracle exactly; use semantic benchmarks for changes
that intentionally alter emitted C. This measures JS-to-C execution, not C builds.
Directories must be new. All logs, outputs, identities, and partial pairs are kept.
Exit 2 means failed or incomplete. Completion alone is not a performance verdict.
`;

const TARGETS = {
	parser: "src/compiler/frontend/parser.ts",
	shape: "src/compiler/core/core-ir-shape-provenance.ts",
	full: "bench/self-compile.mts",
} as const;

interface Options {
	command: "capture" | "compare";
	output: string;
	base?: string;
	candidate?: string;
	host: "native" | "node";
	workload: keyof typeof TARGETS;
	pairs: number;
	budgetSeconds: number;
	plan: boolean;
}

interface Capture {
	schema: 1;
	status: "complete";
	capturedAt: string;
	source: { commit: string; digest: string };
	files: Record<string, string>;
	preparation: string;
	lockfile: string;
	host: { platform: string; arch: string; node: string; cpu: string };
	build: { plan: unknown; toolchain: string; milliseconds: number };
}

interface Sample {
	label: string;
	wallMs: number;
	digest: string;
	units: number;
	codeUnits: number;
	phases: Record<string, number>;
	peakRssBytes?: number;
}

function writeJson(file: string, value: unknown): void {
	const temporary = `${file}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
	renameSync(temporary, file);
}

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function git(args: Array<string>): string {
	const result = spawnSync("git", args, {
		encoding: "utf8",
		timeout: 30_000,
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.error !== undefined) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr);
	return result.stdout;
}

function sourceIdentity(): { commit: string; digest: string } {
	const commit = git(["rev-parse", "HEAD"]).trim();
	const hash = createHash("sha256").update(commit);
	hash.update(git(["diff", "--binary", "HEAD"]));
	for (const file of git(["ls-files", "--others", "--exclude-standard", "-z"])
		.split("\0")
		.filter(Boolean)
		.sort()) {
		const contents = lstatSync(file).isSymbolicLink()
			? Buffer.from(readlinkSync(file))
			: readFileSync(file);
		hash.update(`${file}\0${contents.length}\0`).update(contents);
	}
	return { commit, digest: hash.digest("hex") };
}

function captureFiles(directory: string): Record<string, string> {
	const files: Record<string, string> = {};
	const visit = (relative: string) => {
		const absolute = path.join(directory, relative);
		if (lstatSync(absolute).isDirectory()) {
			for (const name of readdirSync(absolute).sort()) {
				if (relative === "source" && name === "node_modules") continue;
				visit(path.join(relative, name));
			}
		} else {
			files[relative] = sha256(readFileSync(absolute));
		}
	};
	visit("source");
	visit("compiler");
	return files;
}

function currentHost(): Capture["host"] {
	return {
		platform: process.platform,
		arch: process.arch,
		node: process.version,
		cpu: os.cpus()[0]?.model ?? "unknown",
	};
}

function cleanEnvironment(): NodeJS.ProcessEnv {
	const environment = { ...process.env };
	for (const key of Object.keys(environment)) {
		if (key.startsWith("MAL_") || key.startsWith("NODE_")) delete environment[key];
	}
	environment.MAL_CORE_INSTRUMENTATION = "off";
	return environment;
}

async function captureCompiler(directory: string): Promise<void> {
	const { buildNativeBinaryResult } = await import("../src/test-harness.ts");
	const source = sourceIdentity();
	writeFileSync(path.join(directory, "source.patch"), git(["diff", "--binary", "HEAD"]));
	console.log("prepare stripped compiler source");
	prepareSelfCompileSource(path.join(directory, "source"));
	const events: Array<unknown> = [];
	const started = performance.now();
	console.log("build closed native compiler");
	const built = buildNativeBinaryResult({
		fixture: "bench/self-compile.mts",
		name: "self-compile-experiment",
		config: SELF_COMPILE_CONFIG,
		compiled: true,
		translationUnits: true,
		environment: cleanEnvironment(),
		onNativeBuildPhase: (event) => {
			events.push(event);
			console.log(JSON.stringify(event));
		},
	});
	const milliseconds = performance.now() - started;
	copyFileSync(built.binaryPath, path.join(directory, "compiler"));
	writeJson(path.join(directory, "build-events.json"), events);
	if (!isDeepStrictEqual(source, sourceIdentity())) {
		throw new Error("source changed during capture; discard this capture and retry");
	}
	const capture: Capture = {
		schema: 1,
		status: "complete",
		capturedAt: new Date().toISOString(),
		source,
		files: captureFiles(directory),
		preparation: sha256(
			readFileSync("scripts/self-compile-workload.ts", "utf8") +
				readFileSync("src/compiler/frontend/compact-type-strip.ts", "utf8"),
		),
		lockfile: sha256(readFileSync("package-lock.json")),
		host: currentHost(),
		build: {
			plan: built.context.plan,
			toolchain: built.context.toolchain.fingerprint,
			milliseconds,
		},
	};
	writeJson(path.join(directory, "capture.json"), capture);
}

function readCapture(directory: string): Capture {
	const capture = JSON.parse(
		readFileSync(path.join(directory, "capture.json"), "utf8"),
	) as Capture;
	if (capture.schema !== 1 || capture.status !== "complete") {
		throw new Error(`incomplete or unsupported capture: ${directory}`);
	}
	if (!isDeepStrictEqual(capture.files, captureFiles(directory))) {
		throw new Error(`capture contents changed: ${directory}`);
	}
	if (!isDeepStrictEqual(capture.host, currentHost())) {
		throw new Error(`capture host or Node version changed: ${directory}`);
	}
	if (capture.lockfile !== sha256(readFileSync("package-lock.json"))) {
		throw new Error(`capture dependencies changed: ${directory}`);
	}
	return capture;
}

function summarizeCompilerPairs(pairs: ReadonlyArray<readonly [Sample, Sample]>) {
	if (pairs.length === 0) return undefined;
	const mean = (values: ReadonlyArray<number>) =>
		values.reduce((sum, value) => sum + value, 0) / values.length;
	const changes = pairs.map(
		([base, candidate]) => 100 * (1 - candidate.wallMs / base.wallMs),
	);
	const meanReductionPercent = mean(changes);
	return {
		pairs: pairs.length,
		baseMeanMs: mean(pairs.map(([base]) => base.wallMs)),
		candidateMeanMs: mean(pairs.map(([, candidate]) => candidate.wallMs)),
		meanReductionPercent,
		standardDeviationPercentagePoints:
			pairs.length < 2
				? null
				: Math.sqrt(
						changes.reduce(
							(sum, change) => sum + (change - meanReductionPercent) ** 2,
							0,
						) /
							(pairs.length - 1),
					),
		pairReductionsPercent: changes,
	};
}

function compareCapturedCompilers(options: Options): void {
	const baseDirectory = options.base!;
	const candidateDirectory = options.candidate!;
	const base = readCapture(baseDirectory);
	const candidate = readCapture(candidateDirectory);
	if (
		base.preparation !== candidate.preparation ||
		!isDeepStrictEqual(base.build.plan, candidate.build.plan) ||
		base.build.toolchain !== candidate.build.toolchain
	) {
		throw new Error("capture preparation or native toolchain/build plans differ");
	}
	const reportPath = path.join(options.output, "report.json");
	const target = path.join(baseDirectory, "source", TARGETS[options.workload]);
	const pairs: Array<readonly [Sample, Sample]> = [];
	const samples: Array<Sample> = [];
	const report = {
		schema: 1,
		status: "running",
		complete: false,
		options,
		captures: { base, candidate },
		target,
		samples,
		pairs,
	};
	const save = () =>
		writeJson(reportPath, { ...report, summary: summarizeCompilerPairs(pairs) });
	save();
	const run = (label: string, capture: string, host: "native" | "node"): Sample => {
		const directory = path.join(options.output, label);
		mkdirSync(directory);
		const output = path.join(directory, "output");
		const executable =
			host === "node" ? process.execPath : path.join(capture, "compiler");
		const args = [target, output];
		if (host === "node")
			args.unshift(path.join(capture, "source/bench/self-compile.mts"));
		console.log(`${label}: ${executable}`);
		const stdoutPath = path.join(directory, "stdout.json");
		const stderrPath = path.join(directory, "stderr.log");
		const stdout = openSync(stdoutPath, "w");
		const stderr = openSync(stderrPath, "w");
		const timed = process.platform === "darwin" || process.platform === "linux";
		const started = performance.now();
		let result: ReturnType<typeof spawnSync>;
		try {
			result = spawnSync(
				timed ? "/usr/bin/time" : executable,
				timed
					? [process.platform === "darwin" ? "-lp" : "-v", executable, ...args]
					: args,
				{
					env: cleanEnvironment(),
					stdio: ["ignore", stdout, stderr],
				},
			);
		} finally {
			closeSync(stdout);
			closeSync(stderr);
		}
		const wallMs = performance.now() - started;
		if (result.error !== undefined) throw result.error;
		if (result.status !== 0)
			throw new Error(`${label} exited ${result.status}; see ${directory}`);
		const summary = JSON.parse(readFileSync(stdoutPath, "utf8")) as Omit<
			Sample,
			"label" | "wallMs" | "digest"
		>;
		if (
			!Number.isSafeInteger(summary.units) ||
			summary.units <= 0 ||
			!Number.isSafeInteger(summary.codeUnits) ||
			summary.codeUnits <= 0
		)
			throw new Error(`${label} emitted an invalid workload summary`);
		const resourceLog = readFileSync(stderrPath, "utf8");
		const rss =
			process.platform === "darwin"
				? resourceLog.match(/^\s*(\d+)\s+maximum resident set size\s*$/m)?.[1]
				: resourceLog.match(/Maximum resident set size \(kbytes\):\s*(\d+)/)?.[1];
		if (timed && rss === undefined)
			throw new Error(`${label} resource probe omitted peak RSS`);
		return {
			...summary,
			label,
			wallMs,
			digest: digestSelfCompileOutput(output),
			...(rss === undefined
				? {}
				: { peakRssBytes: Number(rss) * (process.platform === "linux" ? 1024 : 1) }),
		};
	};
	const reference = run("node-reference", baseDirectory, "node");
	const checked = (label: string, directory: string): Sample => {
		const sample = run(label, directory, options.host);
		samples.push(sample);
		save();
		if (
			sample.digest !== reference.digest ||
			sample.units !== reference.units ||
			sample.codeUnits !== reference.codeUnits
		)
			throw new Error(
				`${label} output differs from the frozen Node oracle; see ${options.output}`,
			);
		return sample;
	};
	writeJson(path.join(options.output, "oracle.json"), reference);
	checked("warm-base", baseDirectory);
	checked("warm-candidate", candidateDirectory);
	for (let pair = 0; pair < options.pairs; pair++) {
		let baseline: Sample;
		let head: Sample;
		if (pair % 2 === 0) {
			baseline = checked(`pair-${pair}-base`, baseDirectory);
			head = checked(`pair-${pair}-candidate`, candidateDirectory);
		} else {
			head = checked(`pair-${pair}-candidate`, candidateDirectory);
			baseline = checked(`pair-${pair}-base`, baseDirectory);
		}
		pairs.push([baseline, head]);
		save();
	}
	readCapture(baseDirectory);
	readCapture(candidateDirectory);
	report.status = "complete";
	report.complete = true;
	save();
}

function parseOptions(args: Array<string>): Options | undefined {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(HELP);
		return undefined;
	}
	const command = args.shift();
	if (command !== "capture" && command !== "compare") throw new Error(HELP);
	const take = (): string => {
		const value = args.shift();
		if (value === undefined || value.startsWith("--")) throw new Error(HELP);
		return value;
	};
	const first = path.resolve(take());
	const options: Options = {
		command,
		output: command === "capture" ? first : "",
		...(command === "compare" ? { base: first, candidate: path.resolve(take()) } : {}),
		host: "native",
		workload: "parser",
		pairs: 5,
		budgetSeconds: 600,
		plan: false,
	};
	while (args.length > 0) {
		const option = args.shift();
		if (option === "--plan=json") options.plan = true;
		else if (option === "--output" && command === "compare")
			options.output = path.resolve(take());
		else if (option === "--host" && command === "compare") {
			const host = take();
			if (host !== "native" && host !== "node")
				throw new Error("--host requires native or node");
			options.host = host;
		} else if (option === "--workload" && command === "compare") {
			const workload = take();
			if (workload !== "parser" && workload !== "shape" && workload !== "full") {
				throw new Error("--workload requires parser, shape, or full");
			}
			options.workload = workload;
		} else if (
			option === "--budget-seconds" ||
			(option === "--pairs" && command === "compare")
		) {
			const number = Number(take());
			if (!Number.isSafeInteger(number) || number < 1)
				throw new Error(`${option} requires a positive integer`);
			if (option === "--budget-seconds" && number > 2_147_483)
				throw new Error("--budget-seconds exceeds the supported timer range");
			if (option === "--pairs") options.pairs = number;
			else options.budgetSeconds = number;
		} else throw new Error(`unknown option: ${option}`);
	}
	if (!options.output) throw new Error("compare requires --output DIRECTORY");
	return options;
}

async function runBoundedWorker(options: Options): Promise<void> {
	if (existsSync(options.output))
		throw new Error(`output already exists: ${options.output}`);
	mkdirSync(path.dirname(options.output), { recursive: true });
	mkdirSync(options.output);
	const reportPath = path.join(
		options.output,
		options.command === "capture" ? "capture.json" : "report.json",
	);
	writeJson(reportPath, { schema: 1, status: "running", complete: false, options });
	const log = path.join(options.output, "run.log");
	console.log(`${options.command}: ${options.output}\nlog: ${log}`);
	const descriptor = openSync(log, "w");
	let lease: ReturnType<typeof createCacheLease> | undefined;
	try {
		lease = createCacheLease("self-compile-experiment");
		await new Promise<void>((resolve, reject) => {
			const child = spawn(
				process.execPath,
				[import.meta.filename, "--worker", JSON.stringify(options)],
				{
					env: cleanEnvironment(),
					stdio: ["ignore", descriptor, descriptor],
					detached: process.platform !== "win32",
				},
			);
			let interrupted = false;
			const kill = () => {
				if (child.pid === undefined) return;
				if (process.platform === "win32") {
					spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
						timeout: 5000,
					});
				} else {
					try {
						process.kill(-child.pid, "SIGKILL");
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
					}
				}
			};
			const stop = () => {
				interrupted = true;
				kill();
			};
			process.once("SIGINT", stop);
			process.once("SIGTERM", stop);
			const timer = setTimeout(stop, options.budgetSeconds * 1000);
			const cleanup = () => {
				clearTimeout(timer);
				process.removeListener("SIGINT", stop);
				process.removeListener("SIGTERM", stop);
				if (interrupted) kill();
			};
			child.once("error", (error) => {
				cleanup();
				reject(error);
			});
			child.once("close", (code) => {
				cleanup();
				if (interrupted || code !== 0) {
					const error = interrupted
						? "time budget exhausted or interrupted"
						: `worker exited ${code}; see ${log}`;
					const report = JSON.parse(readFileSync(reportPath, "utf8")) as Record<
						string,
						unknown
					>;
					writeJson(reportPath, {
						...report,
						status: interrupted ? "incomplete" : "failed",
						complete: false,
						error,
					});
					reject(new Error(error));
				} else resolve();
			});
		});
	} catch (error) {
		const report = JSON.parse(readFileSync(reportPath, "utf8")) as Record<
			string,
			unknown
		>;
		if (report.status === "running") {
			writeJson(reportPath, {
				...report,
				status: "failed",
				complete: false,
				error: String(error),
			});
		}
		throw error;
	} finally {
		closeSync(descriptor);
		lease?.release();
	}
	console.log(`complete: ${reportPath}`);
}

if (import.meta.main) {
	try {
		if (process.argv[2] === "--worker") {
			const options = JSON.parse(process.argv[3]!) as Options;
			if (options.command === "capture") await captureCompiler(options.output);
			else compareCapturedCompilers(options);
		} else {
			const options = parseOptions(process.argv.slice(2));
			if (options?.plan) {
				console.log(
					JSON.stringify(
						{
							...options,
							work:
								options.command === "capture"
									? [
											"prepare identical stripped Node source",
											"build and preserve native compiler",
											"verify source identity",
										]
									: [
											"verify capture integrity and compatibility",
											"one Node oracle",
											"two warmups",
											`${2 * options.pairs} measured compiler runs`,
											"verify capture integrity",
										],
							failureExitCode: 2,
						},
						null,
						2,
					),
				);
			} else if (options !== undefined) await runBoundedWorker(options);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 2;
	}
}
