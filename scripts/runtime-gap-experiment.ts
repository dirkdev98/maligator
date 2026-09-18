import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	loadRuntimeGapCatalog,
	loadRuntimeGapExperiment,
	RUNTIME_GAP_CATALOG,
} from "./runtime-gap-catalog.ts";
import type { RuntimeGapCaseDescriptor } from "./runtime-gap-catalog.ts";
import { main as runRuntimeGap } from "./runtime-gap.ts";

const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const RUNTIME_GAP_EXPERIMENTS = path.join(
	REPOSITORY_ROOT,
	".cache/performance/experiments",
);

const HELP = `Usage: npm run bench:performance -- experiment COMMAND [options]

Commands:
  new ID [--from CASE] [--control CASE]
  run ID [--preset smoke|verify|confirm] [gap options]
  promote ID [--preset none|survey|quick]
  remove ID
`;

function experimentDirectory(id: string): string {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
		throw new Error("experiment ID must contain lowercase letters, digits, and hyphens");
	}
	return path.join(RUNTIME_GAP_EXPERIMENTS, id);
}

function requiredId(args: ReadonlyArray<string>): string {
	const id = args[0];
	if (id === undefined || id.startsWith("-")) throw new Error(HELP.trim());
	return id;
}

function optionValues(
	args: ReadonlyArray<string>,
	option: string,
): ReadonlyArray<string> {
	const values: Array<string> = [];
	for (const [index, argument] of args.entries()) {
		if (argument === option) {
			const value = args[index + 1];
			if (value === undefined || value.startsWith("-")) throw new Error(HELP.trim());
			values.push(value);
		}
	}
	return values;
}

function scaffold(id: string): string {
	return `import { runRuntimeGapCase } from "../../../../bench/runtime-gap/case-runner.mjs";

function workload(scale) {
	const operations = 100_000 * scale;
	let checksum = 0;
	for (let index = 0; index < operations; index++) checksum += index & 31;
	return { checksum, operations };
}

runRuntimeGapCase(${JSON.stringify(id)}, workload);
`;
}

function scratchSource(id: string, source?: RuntimeGapCaseDescriptor): string {
	if (source === undefined) return scaffold(id);
	const absolute = path.join(REPOSITORY_ROOT, "bench/runtime-gap", source.fixture);
	return readFileSync(absolute, "utf8")
		.replace(
			'from "../case-runner.mjs"',
			'from "../../../../bench/runtime-gap/case-runner.mjs"',
		)
		.replace(
			/runRuntimeGapCase\("[a-z0-9-]+"/,
			`runRuntimeGapCase(${JSON.stringify(id)}`,
		);
}

function newExperiment(args: ReadonlyArray<string>): void {
	const id = requiredId(args);
	const directory = experimentDirectory(id);
	if (existsSync(directory)) throw new Error(`experiment already exists: ${id}`);
	const catalog = loadRuntimeGapCatalog();
	if (catalog.cases.some((candidate) => candidate.id === id)) {
		throw new Error(`catalog case already exists: ${id}`);
	}
	const fromValues = optionValues(args, "--from");
	if (fromValues.length > 1) throw new Error("--from may be supplied once");
	const source =
		fromValues.length === 0
			? undefined
			: catalog.cases.find((candidate) => candidate.id === fromValues[0]);
	if (fromValues.length === 1 && source === undefined) {
		throw new Error(`unknown source case: ${fromValues[0]}`);
	}
	const controls = optionValues(args, "--control");
	for (const control of controls) {
		if (!catalog.cases.some((candidate) => candidate.id === control)) {
			throw new Error(`unknown control case: ${control}`);
		}
	}
	const knownOptions = new Set([id, "--from", ...fromValues, "--control", ...controls]);
	const unknown = args.filter((argument) => !knownOptions.has(argument));
	if (unknown.length > 0) throw new Error(`unknown experiment option: ${unknown[0]}`);
	mkdirSync(directory, { recursive: true });
	writeFileSync(path.join(directory, "case.mjs"), scratchSource(id, source));
	const descriptor: RuntimeGapCaseDescriptor = {
		id,
		group: source?.group ?? "primitive",
		suite: source?.suite ?? "runtime",
		owner: source?.owner ?? `scratch experiment ${id}`,
		category: source?.category ?? "unattributed-execution",
		mechanisms: source?.mechanisms ?? ["scratch-experiment"],
		inputShape: source?.inputShape ?? "edit case.mjs before measuring",
		unit: source?.unit ?? "operation",
		sourceSeam: source?.sourceSeam ?? "scratch experiment",
		fixture: "case.mjs",
		controls,
	};
	writeFileSync(
		path.join(directory, "experiment.json"),
		`${JSON.stringify({ schema: 1, id, case: descriptor }, undefined, "\t")}\n`,
	);
	console.log(path.relative(REPOSITORY_ROOT, directory));
}

function hasOption(args: ReadonlyArray<string>, option: string): boolean {
	return args.includes(option);
}

async function runExperiment(args: ReadonlyArray<string>): Promise<void> {
	const id = requiredId(args);
	const directory = experimentDirectory(id);
	const manifest = path.join(directory, "experiment.json");
	const experiment = loadRuntimeGapExperiment(manifest);
	const presetValues = optionValues(args, "--preset");
	if (presetValues.length > 1) throw new Error("--preset may be supplied once");
	const preset = presetValues[0] ?? "smoke";
	if (preset !== "smoke" && preset !== "verify" && preset !== "confirm") {
		throw new Error(`unknown experiment preset: ${preset}`);
	}
	const forwarded = args.slice(1).filter((argument, index, values) => {
		if (argument === "--preset") return false;
		return index === 0 || values[index - 1] !== "--preset";
	});
	const defaults =
		preset === "smoke"
			? ["--samples", "1", "--target-node-ms", "5", "--budget-seconds", "120"]
			: preset === "verify"
				? ["--samples", "5", "--target-node-ms", "30", "--budget-seconds", "300"]
				: ["--samples", "9", "--target-node-ms", "100", "--budget-seconds", "900"];
	const options = ["--experiment-manifest", manifest, ...defaults, ...forwarded];
	if (!hasOption(forwarded, "--output")) {
		options.push("--output", path.join(directory, "report.json"));
	}
	if (!hasOption(forwarded, "--markdown")) {
		options.push("--markdown", path.join(directory, "report.md"));
	}
	if (preset !== "confirm" && !hasOption(forwarded, "--skip-node-allocation")) {
		options.push("--skip-node-allocation");
	}
	for (const caseId of [experiment.id, ...experiment.case.controls]) {
		options.push("--case", caseId);
	}
	await runRuntimeGap(options);
}

function promoteExperiment(args: ReadonlyArray<string>): void {
	const id = requiredId(args);
	const presetValues = optionValues(args, "--preset");
	if (presetValues.length > 1) throw new Error("--preset may be supplied once");
	const preset = presetValues[0] ?? "none";
	if (preset !== "none" && preset !== "survey" && preset !== "quick") {
		throw new Error(`unknown promotion preset: ${preset}`);
	}
	const known = new Set([id, "--preset", ...presetValues]);
	const unknown = args.filter((argument) => !known.has(argument));
	if (unknown.length > 0) throw new Error(`unknown experiment option: ${unknown[0]}`);
	const directory = experimentDirectory(id);
	const experiment = loadRuntimeGapExperiment(path.join(directory, "experiment.json"));
	const catalog = loadRuntimeGapCatalog();
	const destination = path.join(REPOSITORY_ROOT, "bench/runtime-gap/cases", `${id}.mjs`);
	if (existsSync(destination) || catalog.cases.some((candidate) => candidate.id === id)) {
		throw new Error(`promotion target already exists: ${id}`);
	}
	const raw = JSON.parse(readFileSync(RUNTIME_GAP_CATALOG, "utf8")) as {
		schema: 1;
		presets: { quick: Array<string>; survey: Array<string> };
		cases: Array<RuntimeGapCaseDescriptor>;
	};
	const { fixturePath: _fixturePath, ...caseDescriptor } = experiment.case;
	raw.cases.push({ ...caseDescriptor, fixture: `cases/${id}.mjs` });
	if (preset === "quick") raw.presets.quick.push(id);
	if (preset === "quick" || preset === "survey") raw.presets.survey.push(id);
	const source = readFileSync(path.join(directory, "case.mjs"), "utf8").replace(
		'from "../../../../bench/runtime-gap/case-runner.mjs"',
		'from "../case-runner.mjs"',
	);
	writeFileSync(`${destination}.tmp`, source);
	writeFileSync(
		`${RUNTIME_GAP_CATALOG}.tmp`,
		`${JSON.stringify(raw, undefined, "\t")}\n`,
	);
	renameSync(`${destination}.tmp`, destination);
	renameSync(`${RUNTIME_GAP_CATALOG}.tmp`, RUNTIME_GAP_CATALOG);
	rmSync(directory, { recursive: true });
	console.log(path.relative(REPOSITORY_ROOT, destination));
}

function removeExperiment(args: ReadonlyArray<string>): void {
	const id = requiredId(args);
	if (args.length !== 1) throw new Error(HELP.trim());
	const directory = experimentDirectory(id);
	if (!existsSync(directory)) throw new Error(`experiment does not exist: ${id}`);
	rmSync(directory, { recursive: true });
}

export async function runExperimentCommand(args: ReadonlyArray<string>): Promise<void> {
	const [command, ...commandArgs] = args;
	if (command === undefined || command === "--help" || command === "-h") {
		console.log(HELP);
		return;
	}
	if (command === "new") newExperiment(commandArgs);
	else if (command === "run") await runExperiment(commandArgs);
	else if (command === "promote") promoteExperiment(commandArgs);
	else if (command === "remove") removeExperiment(commandArgs);
	else throw new Error(`unknown experiment command: ${command}`);
}
