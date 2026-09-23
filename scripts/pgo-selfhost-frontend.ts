import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { buildModuleGraph } from "../src/compiler/frontend/module-graph.ts";
import {
	createPgoCapture,
	finalizePgoCapture,
	mergePgoCaptures,
	readPreparedPgoTraining,
} from "../src/pgo-artifact.ts";
import { SELF_COMPILE_CONFIG } from "./self-compile-workload.ts";

const WORKLOADS = [
	{
		name: "compiler-summaries",
		source: "src/compiler/core/core-ir-summaries.ts",
		train: true,
	},
	{
		name: "compiler-shape",
		source: "src/compiler/core/core-ir-shape-provenance.ts",
		train: false,
	},
	{
		name: "compiler-pass-manager",
		source: "src/compiler/core/core-pass-manager.ts",
		train: false,
	},
	{
		name: "compiler-region-selection",
		source: "src/compiler/core/core-ir-region-selection.ts",
		train: false,
	},
] as const;

interface Options {
	command: "oracle" | "train" | "compare";
	snapshot: string;
	output: string;
	trainingBinary?: string;
	staticBinary?: string;
	pgoBinary?: string;
	budgetSeconds: number;
	childTimeoutSeconds: number;
	pairs: number;
	workloads: Array<string>;
	plan: boolean;
}

interface SourceCapture {
	schema: 4;
	kind: "node";
	status: "complete";
	files: Record<string, string>;
	lockfile: string;
}

const HELP = `Usage: node scripts/pgo-selfhost-frontend.ts train --snapshot CAPTURE --training-binary PATH --out DIR [--workloads NAME,...] [--budget-seconds N] [--child-timeout-seconds N] [--plan=json]
       node scripts/pgo-selfhost-frontend.ts compare --snapshot CAPTURE --static-binary PATH --pgo-binary PATH --out DIR [--workloads NAME,...] [--pairs N] [--budget-seconds N] [--child-timeout-seconds N] [--plan=json]
       node scripts/pgo-selfhost-frontend.ts oracle --snapshot CAPTURE --out DIR [--workloads NAME,...] [--budget-seconds N] [--child-timeout-seconds N] [--plan=json]

The source-only CAPTURE comes from bench:self-compile-experiment capture DIR --source-only.
Build all three binaries from that same frozen source/src/selfhost-frontend-entry.mts.
This runner never builds a binary. Train merges only exact-wire-matching captures;
compare checks both training inputs and separate holdouts against the frozen Node oracle.
Output directories must be new. Incomplete reports and captures are retained.
`;

function parseOptions(args: Array<string>): Options | undefined {
	if (args[0] === "--help" || args[0] === "-h") return undefined;
	const command = args[0];
	if (command !== "oracle" && command !== "train" && command !== "compare")
		throw new Error(HELP);
	const options: Options = {
		command,
		snapshot: "",
		output: "",
		budgetSeconds: 300,
		childTimeoutSeconds: 60,
		pairs: 3,
		workloads: WORKLOADS.map((item) => item.name),
		plan: false,
	};
	for (let index = 1; index < args.length; index++) {
		const option = args[index]!;
		if (option === "--plan=json") {
			options.plan = true;
			continue;
		}
		const value = args[++index];
		if (value === undefined || value.startsWith("--")) throw new Error(HELP);
		if (option === "--snapshot") options.snapshot = value;
		else if (option === "--out") options.output = value;
		else if (option === "--training-binary") options.trainingBinary = value;
		else if (option === "--static-binary") options.staticBinary = value;
		else if (option === "--pgo-binary") options.pgoBinary = value;
		else if (option === "--budget-seconds") options.budgetSeconds = Number(value);
		else if (option === "--child-timeout-seconds")
			options.childTimeoutSeconds = Number(value);
		else if (option === "--pairs") options.pairs = Number(value);
		else if (option === "--workloads") options.workloads = value.split(",");
		else throw new Error(HELP);
	}
	if (
		!options.snapshot ||
		!options.output ||
		!Number.isSafeInteger(options.budgetSeconds) ||
		options.budgetSeconds < 1 ||
		!Number.isSafeInteger(options.childTimeoutSeconds) ||
		options.childTimeoutSeconds < 1 ||
		!Number.isSafeInteger(options.pairs) ||
		options.pairs < 1 ||
		options.workloads.length === 0 ||
		new Set(options.workloads).size !== options.workloads.length ||
		options.workloads.some((name) => !WORKLOADS.some((item) => item.name === name)) ||
		(command === "train" &&
			!WORKLOADS.some((item) => item.train && options.workloads.includes(item.name))) ||
		(command === "train" && !options.trainingBinary) ||
		(command === "compare" && (!options.staticBinary || !options.pgoBinary))
	)
		throw new Error(HELP);
	return options;
}

function sha256(bytes: string | Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function writeReport(file: string, value: unknown): void {
	const temporary = `${file}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
	renameSync(temporary, file);
}

function sourceIdentity(snapshot: string): {
	capture: string;
	closure: string;
	source: string;
} {
	const manifestPath = path.join(snapshot, "capture.json");
	const capture = JSON.parse(readFileSync(manifestPath, "utf8")) as SourceCapture;
	if (capture.schema !== 4 || capture.kind !== "node" || capture.status !== "complete")
		throw new Error("expected a complete source-only self-compile capture");
	for (const [relative, digest] of Object.entries(capture.files)) {
		if (!relative.startsWith("source/") || relative.includes(".."))
			throw new Error(`invalid capture file: ${relative}`);
		if (sha256(readFileSync(path.join(snapshot, relative))) !== digest)
			throw new Error(`source capture changed: ${relative}`);
	}
	if (capture.lockfile !== sha256(readFileSync("package-lock.json")))
		throw new Error("source capture lockfile differs from the installed dependencies");
	const source = path.join(snapshot, "source");
	const graph = buildModuleGraph(path.join(source, "src/selfhost-frontend-entry.mts"), {
		buildConfig: SELF_COMPILE_CONFIG,
		stripTypes: stripCompactTypes,
	});
	const closure = createHash("sha256");
	for (const module of [...graph.modules.values()].sort((a, b) =>
		a.path.localeCompare(b.path),
	)) {
		closure.update(module.path).update("\0").update(module.source).update("\0");
	}
	return {
		capture: sha256(readFileSync(manifestPath)),
		closure: closure.digest("hex"),
		source,
	};
}

function cleanEnvironment(): NodeJS.ProcessEnv {
	const environment = { ...process.env };
	for (const key of Object.keys(environment))
		if (key.startsWith("MAL_") || key.startsWith("NODE_")) delete environment[key];
	return environment;
}

function run(
	program: string,
	args: Array<string>,
	log: string,
	deadline: number,
	childTimeoutSeconds: number,
	environment: NodeJS.ProcessEnv,
): number {
	const remaining = Math.floor(deadline - Date.now());
	if (remaining <= 0) throw new Error("workload budget exhausted");
	const descriptor = openSync(log, "wx");
	const started = performance.now();
	let completed = false;
	try {
		const result = spawnSync(program, args, {
			env: environment,
			stdio: ["ignore", descriptor, descriptor],
			timeout: Math.min(remaining, childTimeoutSeconds * 1000),
		});
		if (result.error !== undefined) throw result.error;
		if (result.status !== 0)
			throw new Error(
				`${path.basename(program)} exited ${result.status ?? result.signal}; see ${log}`,
			);
		completed = true;
		return performance.now() - started;
	} finally {
		closeSync(descriptor);
		if (completed && statSync(log).size === 0) rmSync(log);
	}
}

function assertWire(actual: string, oracle: string): string {
	if (!existsSync(actual)) throw new Error(`compiler did not write ${actual}`);
	const bytes = readFileSync(actual);
	if (!bytes.equals(readFileSync(oracle)))
		throw new Error(`compiler wire differs from Node oracle: ${actual}`);
	return sha256(bytes);
}

function execute(options: Options): void {
	const snapshot = path.resolve(options.snapshot);
	const output = path.resolve(options.output);
	const identity = sourceIdentity(snapshot);
	mkdirSync(path.dirname(output), { recursive: true });
	mkdirSync(output);
	const reportPath = path.join(output, "report.json");
	const report: Record<string, unknown> = {
		schema: 1,
		status: "incomplete",
		command: options.command,
		budgetSeconds: options.budgetSeconds,
		childTimeoutSeconds: options.childTimeoutSeconds,
		pairs: options.command === "compare" ? options.pairs : undefined,
		capture: identity.capture,
		compilerClosure: identity.closure,
		workloads: [],
	};
	const results = report.workloads as Array<Record<string, unknown>>;
	writeReport(reportPath, report);
	const deadline = Date.now() + options.budgetSeconds * 1000;
	const env = cleanEnvironment();
	try {
		const training =
			options.command === "train"
				? readPreparedPgoTraining(path.resolve(options.trainingBinary!))
				: undefined;
		const binaries =
			options.command === "compare"
				? {
						static: path.resolve(options.staticBinary!),
						pgo: path.resolve(options.pgoBinary!),
					}
				: undefined;
		const binaryPaths: Record<string, string> =
			binaries ??
			(options.command === "train"
				? { training: path.resolve(options.trainingBinary!) }
				: {});
		report.binaries = Object.fromEntries(
			Object.entries(binaryPaths).map(([name, binary]) => [
				name,
				sha256(readFileSync(binary)),
			]),
		);
		const captures: Array<string> = [];
		for (const workload of WORKLOADS) {
			if (!options.workloads.includes(workload.name)) continue;
			if (options.command === "train" && !workload.train) continue;
			const item: Record<string, unknown> = {
				name: workload.name,
				source: workload.source,
				role: workload.train ? "train" : "holdout",
			};
			results.push(item);
			writeReport(reportPath, report);
			const input = path.join(identity.source, workload.source);
			const oracle = path.join(output, `${workload.name}-node.malw`);
			const script = path.join(identity.source, "src/selfhost-frontend-entry.mts");
			item.nodeMs = run(
				process.execPath,
				[script, input, oracle],
				path.join(output, `${workload.name}-node.log`),
				deadline,
				options.childTimeoutSeconds,
				env,
			);
			item.wireSha256 = sha256(readFileSync(oracle));
			if (training !== undefined) {
				const capture = createPgoCapture(
					training,
					workload.name,
					path.join(output, "captures"),
				);
				item.capture = path.join(capture.directory, "manifest.json");
				writeReport(reportPath, report);
				const actual = path.join(output, `${workload.name}-training.malw`);
				let attemptedFinalize = false;
				try {
					item.trainingMs = run(
						path.resolve(options.trainingBinary!),
						[input, actual],
						path.join(output, `${workload.name}-training.log`),
						deadline,
						options.childTimeoutSeconds,
						{ ...env, ...capture.environment, MAL_INTERP: "1" },
					);
					assertWire(actual, oracle);
					rmSync(actual);
					attemptedFinalize = true;
					finalizePgoCapture(capture, true);
					captures.push(item.capture as string);
				} catch (error) {
					if (!attemptedFinalize)
						try {
							finalizePgoCapture(capture, false);
						} catch {
							// The incomplete manifest is the useful result; preserve the original failure.
						}
					throw error;
				}
			} else if (binaries !== undefined) {
				const samples: Array<{ binary: string; wallMs: number }> = [];
				item.samples = samples;
				for (let pair = -1; pair < options.pairs; pair++) {
					const order =
						pair % 2 === 0 ? (["static", "pgo"] as const) : (["pgo", "static"] as const);
					for (const name of order) {
						const label = `${workload.name}-${name}-${pair < 0 ? "warmup" : pair}`;
						const actual = path.join(output, `${label}.malw`);
						const wallMs = run(
							binaries[name],
							[input, actual],
							path.join(output, `${label}.log`),
							deadline,
							options.childTimeoutSeconds,
							env,
						);
						assertWire(actual, oracle);
						rmSync(actual);
						if (pair >= 0) samples.push({ binary: name, wallMs });
					}
				}
			}
			writeReport(reportPath, report);
		}
		if (training !== undefined)
			report.profile = mergePgoCaptures(captures, path.join(output, "profile.json")).path;
		if (identity.closure !== sourceIdentity(snapshot).closure)
			throw new Error("compiler source or resolved dependency changed during the run");
		for (const [name, binary] of Object.entries(binaryPaths)) {
			if (
				sha256(readFileSync(binary)) !== (report.binaries as Record<string, string>)[name]
			)
				throw new Error(`${name} binary changed during the run`);
		}
		report.status = "complete";
		writeReport(reportPath, report);
		console.log(`complete: ${reportPath}`);
	} catch (error) {
		report.error = String(error);
		writeReport(reportPath, report);
		throw error;
	}
}

if (import.meta.main) {
	try {
		const options = parseOptions(process.argv.slice(2));
		if (options === undefined) console.log(HELP);
		else if (options.plan)
			console.log(
				JSON.stringify(
					{
						...options,
						sourceIdentity: existsSync(path.join(options.snapshot, "capture.json"))
							? sourceIdentity(path.resolve(options.snapshot))
							: undefined,
						workloads: WORKLOADS.filter(
							(item) =>
								options.workloads.includes(item.name) &&
								(options.command !== "train" || item.train),
						),
						runs:
							options.command === "oracle"
								? `${options.workloads.length} Node oracles`
								: options.command === "train"
									? `${WORKLOADS.filter((item) => item.train && options.workloads.includes(item.name)).length} Node oracles + ${WORKLOADS.filter((item) => item.train && options.workloads.includes(item.name)).length} instrumented captures + explicit merge`
									: `${options.workloads.length} Node oracles + ${2 * options.workloads.length * (options.pairs + 1)} native runs including warmups`,
						failureExitCode: 2,
					},
					null,
					2,
				),
			);
		else execute(options);
	} catch (error) {
		console.error(error);
		process.exitCode = 2;
	}
}
