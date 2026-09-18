import { spawnSync } from "node:child_process";
import { hash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { maligatorCacheDirectory } from "../src/cache-root.ts";
import { CommandProgress, formatCommandDuration } from "../src/command-progress.ts";
import { hashDirectoryTreesCached } from "../src/file-tree.ts";
import {
	readTestTelemetry,
	summarizeTestTelemetry,
	TEST_TELEMETRY_ENV,
} from "../src/test-telemetry.ts";
import type { TestTelemetrySummary } from "../src/test-telemetry.ts";
import { TEST262_METADATA } from "../src/test262/constants.ts";
import {
	nestedTestWorkerAllocation,
	workerBudget,
	workerCount,
	workerEnvironment,
} from "../src/worker-budget.ts";
import {
	commandEnvironmentPlan,
	mergeCommandRequirements,
	requirementsForCommand,
} from "./command-requirements.ts";
import type { CommandKind, CommandRequirements } from "./command-requirements.ts";
import { cleanTestEnvironment } from "./test-environment.ts";

type Tier = "smoke" | "check" | "full";
type Policy = "bail" | "complete";

interface Command {
	kind: CommandKind;
	name: string;
	command: string;
	args: Array<string>;
	requirements: CommandRequirements;
	env?: NodeJS.ProcessEnv;
}

interface StageReport {
	name: string;
	invocation: string;
	startedAt: string;
	durationMs: number;
	status: number | null;
	signal: NodeJS.Signals | null;
	telemetry: TestTelemetrySummary;
	workers: StageWorkers;
}

interface StageWorkers {
	testWorkers: number;
	childBuildJobs: number;
	preparationBuildJobs: number;
}

const root = path.resolve(import.meta.dirname, "..");
const NOMINAL_SMOKE_WORKERS = 4;
const WARM_SMOKE_FUSE_MS = 20_000;
const COLD_SMOKE_FUSE_MS = 600_000;

function smokeBudgetForWorkers(workers: number): { warmMs: number; coldMs: number } {
	const divisor = Math.min(workers, NOMINAL_SMOKE_WORKERS);
	return {
		warmMs: Math.ceil((WARM_SMOKE_FUSE_MS * NOMINAL_SMOKE_WORKERS) / divisor),
		coldMs: Math.ceil((COLD_SMOKE_FUSE_MS * NOMINAL_SMOKE_WORKERS) / divisor),
	};
}

const usage = `usage: node scripts/test-suite.ts [smoke|check|full] [options]

Tiers are cumulative: check starts with smoke; full starts with smoke and check.

Commands:
  npm run test:smoke          20-second warm / ten-minute cold fuse at four workers
  npm run test:check          canonical developer gate; native cache warmth affects duration
  npm run test:full           exhaustive fail-fast gate; approval required
  npm run test:full:report    exhaustive completion gate; approval required
  npm run test262:report      full Test262 report; approval required
  npm run test:wpt:report     complete compiled/normal curated WPT report
  npm run test:wpt:matrix-report
                              complete WPT backend/GC matrix report

Focused lanes:
  npm run test:unit           pure-TypeScript watch loop
  npm run test:native         native fixture project
  npm run test:sanitize       platform sanitizer project
  npm run test:rust           Rust runtime unit suite
  npm run test262:regressions cumulative curated Test262 selection
  npm run test:wpt -- [args]  curated WPT runner

Options:
  --policy bail|complete  stop at the first failure or finish every stage
  --exclude-quality       omit type-check/lint and report the excluded coverage
  --test262-baseline PATH  explicit Test262 comparison input for every standards stage
  --workers N             total worker budget (default: half the available CPUs)
  --list                  print the exact commands without running them
  --plan=json             print commands and environment requirements as JSON
  -h, --help              show this help

Pass --list through a tier command, for example npm run test:check -- --list.`;

function exitWithUsage(message?: string): never {
	if (message !== undefined) console.error(message);
	console.log(usage);
	process.exit(message === undefined ? 0 : 1);
}

function parseArguments(): {
	tier: Tier;
	policy: Policy;
	list: boolean;
	jsonPlan: boolean;
	excludeQuality: boolean;
	test262Baseline?: string;
	workers: number;
} {
	let tier: Tier = "check";
	let tierSeen = false;
	let policy: Policy = "bail";
	let policySeen = false;
	let list = false;
	let jsonPlan = false;
	let excludeQuality = false;
	let test262Baseline: string | undefined;
	let workers: number | undefined;
	for (let index = 2; index < process.argv.length; index++) {
		const argument = process.argv[index];
		if (argument === "-h" || argument === "--help") exitWithUsage();
		if (argument === "smoke" || argument === "check" || argument === "full") {
			if (tierSeen) exitWithUsage("the test tier may only be specified once");
			tier = argument;
			tierSeen = true;
			continue;
		}
		if (argument === "--policy") {
			if (policySeen) exitWithUsage("--policy may only be specified once");
			const value = process.argv[++index];
			if (value !== "bail" && value !== "complete") {
				exitWithUsage("--policy must be bail or complete");
			}
			policy = value;
			policySeen = true;
			continue;
		}
		if (argument === "--exclude-quality") {
			if (excludeQuality) exitWithUsage("--exclude-quality may only be specified once");
			excludeQuality = true;
			continue;
		}
		if (argument === "--test262-baseline") {
			const value = process.argv[++index];
			if (test262Baseline !== undefined || value === undefined || value.startsWith("-")) {
				exitWithUsage("--test262-baseline requires one file path");
			}
			test262Baseline = path.resolve(value);
			continue;
		}
		if (argument === "--workers") {
			if (workers !== undefined) exitWithUsage("--workers may only be specified once");
			const value = process.argv[++index];
			if (value === undefined) exitWithUsage("--workers requires a positive integer");
			try {
				workers = workerCount(value, "--workers", 1);
			} catch (error) {
				exitWithUsage(error instanceof Error ? error.message : String(error));
			}
			continue;
		}
		if (argument === "--list") {
			if (list) exitWithUsage("--list may only be specified once");
			list = true;
			continue;
		}
		if (argument === "--plan=json") {
			if (jsonPlan) exitWithUsage("--plan=json may only be specified once");
			jsonPlan = true;
			continue;
		}
		exitWithUsage(`unknown argument: ${argument}`);
	}
	if (list && jsonPlan) exitWithUsage("--list and --plan=json cannot be combined");
	return {
		tier,
		policy,
		list,
		jsonPlan,
		excludeQuality,
		test262Baseline,
		workers: workers ?? workerBudget(process.env.MALIGATOR_WORKERS),
	};
}

function readManifest(file: string): Array<string> {
	const entries = readFileSync(path.join(root, file), "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"));
	if (new Set(entries).size !== entries.length) {
		throw new Error(`${file} contains duplicate entries`);
	}
	if (entries.length === 0) throw new Error(`${file} must contain at least one entry`);
	return entries;
}

function assertDisjoint(label: string, left: Array<string>, right: Array<string>) {
	const leftSet = new Set(left);
	const overlap = right.filter((entry) => leftSet.has(entry));
	if (overlap.length > 0) {
		throw new Error(`${label} selections overlap: ${overlap.join(", ")}`);
	}
}

function assertCompleteSelection(
	label: string,
	available: Array<string>,
	selected: Array<string>,
) {
	const availableSet = new Set(available);
	const selectedSet = new Set(selected);
	const unknown = selected.filter((entry) => !availableSet.has(entry));
	const missing = available.filter((entry) => !selectedSet.has(entry));
	if (unknown.length > 0 || missing.length > 0) {
		const unknownMessage = unknown.length > 0 ? `; unknown: ${unknown.join(", ")}` : "";
		const missingMessage =
			missing.length > 0 ? `; unregistered: ${missing.join(", ")}` : "";
		throw new Error(`${label} selection mismatch${unknownMessage}${missingMessage}`);
	}
}

function listFilesRecursively(
	directory: string,
	include: (file: string) => boolean,
): Array<string> {
	return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(
		(entry) => {
			const file = path.posix.join(directory, entry.name);
			if (entry.isDirectory()) return listFilesRecursively(file, include);
			return entry.isFile() && include(file) ? [file] : [];
		},
	);
}

function npm(
	name: string,
	script: string,
	args: Array<string> = [],
	kind: CommandKind = npmCommandKind(script),
): Command {
	return {
		kind,
		name,
		command: "npm",
		args: ["run", script, ...(args.length > 0 ? ["--", ...args] : [])],
		requirements: requirementsForCommand(kind),
	};
}

function npmCommandKind(script: string): CommandKind {
	if (script === "type-check" || script === "lint:ci") return "quality";
	if (script === "test:unit" || script === "test:unit:full-only") return "unit";
	if (script === "test:rust") return "rust";
	if (script === "test:wpt") return "standards";
	return "native";
}

function node(
	name: string,
	script: string,
	args: Array<string> = [],
	kind: CommandKind = script.includes("test262") ? "standards" : "compiler",
): Command {
	return {
		kind,
		name,
		command: process.execPath,
		args: [
			script,
			...args,
			...(script === "scripts/test262.ts" && test262Baseline !== undefined
				? ["--baseline", test262Baseline]
				: []),
		],
		requirements: requirementsForCommand(kind),
	};
}

function shellArgument(value: string): string {
	return /^[\w./:=+-]+$/.test(value) ? value : JSON.stringify(value);
}

function formatCommand(command: Command): string {
	const environment = Object.entries(stageEnvironment(command))
		.map(([name, value]) => `${name}=${shellArgument(value ?? "")}`)
		.join(" ");
	const invocation = [command.command, ...command.args].map(shellArgument).join(" ");
	return environment.length === 0 ? invocation : `${environment} ${invocation}`;
}

function stageWorkers(command: Command): StageWorkers {
	const selectedTestFiles = command.args.filter((argument) =>
		argument.endsWith(".test.ts"),
	).length;
	const pooled =
		selectedTestFiles > 0 ||
		command.kind === "rust" ||
		command.args.includes("scripts/test262.ts");
	const allocation = nestedTestWorkerAllocation(
		workers,
		selectedTestFiles,
		command.kind === "native",
	);
	const testWorkers = pooled ? allocation.testWorkers : 1;
	return {
		testWorkers,
		childBuildJobs: pooled ? allocation.childBuildJobs : workers,
		preparationBuildJobs: workers,
	};
}

function stageEnvironment(command: Command): NodeJS.ProcessEnv {
	const allocation = stageWorkers(command);
	const nestedVitestBuilds = command.args.some((argument) =>
		argument.endsWith(".test.ts"),
	);
	const buildJobs = nestedVitestBuilds
		? allocation.childBuildJobs
		: allocation.preparationBuildJobs;
	return {
		...workerEnvironment(workers),
		MAL_TEST_WORKERS: String(allocation.testWorkers),
		MAL_BUILD_JOBS: String(buildJobs),
		CARGO_BUILD_JOBS: String(buildJobs),
		MAL_SANITIZER_WORKERS: String(allocation.testWorkers),
		MAL_PREPARATION_BUILD_JOBS: String(allocation.preparationBuildJobs),
		...command.env,
	};
}

function selectionArgs(entries: Array<string>, option: string): Array<string> {
	return entries.flatMap((entry) => [option, entry]);
}

function runCommand(
	command: Command,
	progress: CommandProgress,
	current: number,
	total: number,
	telemetryDirectory: string,
): StageReport {
	progress.stage(current, total, command.name);
	rmSync(telemetryDirectory, { recursive: true, force: true });
	mkdirSync(telemetryDirectory, { recursive: true });
	const startedAt = new Date();
	const startedAtMs = performance.now();
	const result = spawnSync(command.command, command.args, {
		cwd: root,
		env: cleanTestEnvironment({
			...stageEnvironment(command),
			[TEST_TELEMETRY_ENV]: telemetryDirectory,
		}),
		stdio: "inherit",
	});
	const report: StageReport = {
		name: command.name,
		invocation: formatCommand(command),
		startedAt: startedAt.toISOString(),
		durationMs: Math.round((performance.now() - startedAtMs) * 1000) / 1000,
		status: result.status,
		signal: result.signal,
		telemetry: summarizeTestTelemetry(readTestTelemetry(telemetryDirectory)),
		workers: stageWorkers(command),
	};
	if (result.status === 0) {
		progress.stagePassed(current, total, command.name);
		return report;
	}
	if (result.error?.message) console.error(`[test-suite] ${result.error.message}`);
	else if (result.signal) console.error(`[test-suite] terminated by ${result.signal}`);
	else console.error(`[test-suite] exited with status ${result.status ?? "unknown"}`);
	progress.stageFailed(current, total, command.name);
	return report;
}

const { tier, policy, list, jsonPlan, excludeQuality, test262Baseline, workers } =
	parseArguments();
const fullOnlyUnit = readManifest("tests/test-suite-unit-full-only.txt");
const unitSmoke = readManifest("tests/test-suite-unit-smoke.txt");
const nativeSmoke = readManifest("tests/test-suite-native-smoke.txt");
const nativeCheck = readManifest("tests/test-suite-native-check.txt");
const nativeSanitizer = readManifest("tests/test-suite-native-sanitizer.txt");
const test262Smoke = readManifest("tests/test-suite-test262-smoke.txt");
const test262Check = readManifest("tests/test-suite-test262-check.txt");
const test262Gc = readManifest("tests/test-suite-test262-gc.txt");
const test262GcSloppy = readManifest("tests/test-suite-test262-gc-sloppy.txt");
const wptSmoke = readManifest("tests/test-suite-wpt-smoke.txt");
const wptCheck = readManifest("tests/test-suite-wpt-check.txt");
assertDisjoint("native smoke/check", nativeSmoke, nativeCheck);
assertDisjoint("Test262 smoke/check", test262Smoke, test262Check);
assertDisjoint("Test262 GC strict/sloppy", test262Gc, test262GcSloppy);
assertDisjoint("WPT smoke/check", wptSmoke, wptCheck);

const curatedWpt = JSON.parse(
	readFileSync(path.join(root, "tests/wpt/curated.json"), "utf8"),
) as { tests: Array<{ path: string }> };
const curatedWptPaths = curatedWpt.tests.map((entry) => entry.path);
assertCompleteSelection("WPT smoke/check", curatedWptPaths, [...wptSmoke, ...wptCheck]);

const allUnit = listFilesRecursively(
	"tests",
	(file) =>
		file.endsWith(".test.ts") &&
		!file.startsWith("tests/fixtures/") &&
		!file.startsWith("tests/native/"),
).sort();
for (const entry of fullOnlyUnit) {
	if (!allUnit.includes(entry)) throw new Error(`unknown full-only unit test: ${entry}`);
}
const fullOnlyUnitSet = new Set(fullOnlyUnit);
const regularUnit = allUnit.filter((entry) => !fullOnlyUnitSet.has(entry));
assertDisjoint("unit smoke/full-only", unitSmoke, fullOnlyUnit);
for (const entry of unitSmoke) {
	if (!regularUnit.includes(entry)) throw new Error(`unknown smoke unit test: ${entry}`);
}
const unitSmokeSet = new Set(unitSmoke);
const unitCheck = regularUnit.filter((entry) => !unitSmokeSet.has(entry));
assertCompleteSelection("unit smoke/check", regularUnit, [...unitSmoke, ...unitCheck]);
const allNative = listFilesRecursively("tests/native", (file) =>
	file.endsWith(".test.ts"),
).sort();
const leakNative = "tests/native/leak.test.ts";
const reservedNative = new Set([...nativeSmoke, ...nativeCheck, leakNative]);
for (const entry of reservedNative) {
	if (!allNative.includes(entry)) throw new Error(`unknown native selection: ${entry}`);
}
const nativeFull = allNative.filter((entry) => !reservedNative.has(entry));
const runnableNative = allNative.filter((entry) => entry !== leakNative);
for (const entry of nativeSanitizer) {
	if (!runnableNative.includes(entry)) {
		throw new Error(`unknown sanitizer native test: ${entry}`);
	}
}
const nativeSanitizerSet = new Set(nativeSanitizer);
const nativeNormal = runnableNative.filter((entry) => !nativeSanitizerSet.has(entry));
assertCompleteSelection("native normal/sanitizer dimensions", runnableNative, [
	...nativeNormal,
	...nativeSanitizer,
]);
const runnerPolicy = ["--policy", policy];
const vitestPolicy = policy === "bail" ? ["--bail=1"] : [];

function nativeDimensionCommands(label: string, entries: Array<string>): Array<Command> {
	const normal = entries.filter((entry) => !nativeSanitizerSet.has(entry));
	const sanitizer = entries.filter((entry) => nativeSanitizerSet.has(entry));
	return [
		...(normal.length === 0
			? []
			: [npm(`${label}: native normal`, "test:native", [...vitestPolicy, ...normal])]),
		...(sanitizer.length === 0
			? []
			: [
					npm(`${label}: native sanitizer-primary`, "test:sanitize", [
						...vitestPolicy,
						...sanitizer,
					]),
				]),
	];
}

const allSmokeCommands: Array<Command> = [
	npm("smoke: TypeScript", "type-check"),
	npm("smoke: fast unit suite", "test:unit", [
		"--run",
		...vitestPolicy,
		"--sequence.seed=1",
		...unitSmoke,
	]),
	...nativeDimensionCommands("smoke", nativeSmoke).map((command) => ({
		...command,
		env: { ...command.env, MAL_NATIVE_PREWARM: "0" },
	})),
	node("smoke: Test262 cross-section", "scripts/test262.ts", [
		"--canonical",
		"--backend",
		"wire",
		"--manifest",
		"tests/test-suite-test262-smoke.txt",
		"--check",
		...runnerPolicy,
	]),
	npm("smoke: WPT cross-section", "test:wpt", [
		"--canonical",
		...selectionArgs(wptSmoke, "--test"),
		"--mode",
		"normal",
		"--backend",
		"wire",
		...runnerPolicy,
	]),
];

const qualityCommands: Array<Command> = [npm("check: lint and format", "lint:ci")];

const checkMatrixCommands: Array<Command> = [
	npm("check: unit complement", "test:unit", [
		"--run",
		...vitestPolicy,
		"--sequence.seed=1",
		...unitCheck,
	]),
	...nativeDimensionCommands("check", nativeCheck),
	node("check: Test262 regression complement", "scripts/test262.ts", [
		"--canonical",
		"--backend",
		"wire",
		"--manifest",
		"tests/test-suite-test262-check.txt",
		"--check",
		...runnerPolicy,
	]),
	npm("check: WPT complement", "test:wpt", [
		"--canonical",
		...selectionArgs(wptCheck, "--test"),
		"--mode",
		"normal",
		"--backend",
		"wire",
		...runnerPolicy,
	]),
];

const selfHostedScripts = [
	"scripts/selfhost-frontend-check.ts",
	"scripts/selfhost-native-build-check.ts",
	"scripts/selfhost-cli-check.ts",
];
assertCompleteSelection(
	"self-hosted checks",
	listFilesRecursively("scripts", (file) => /\/selfhost-.*-check\.ts$/.test(file)),
	selfHostedScripts,
);
const selfHostedCommands: Array<Command> = [
	node("full: self-hosted frontend", selfHostedScripts[0]!),
	node("full: self-hosted native build", selfHostedScripts[1]!),
	node("full: self-hosted CLI", selfHostedScripts[2]!),
];

const fullOnlyUnitCommand = npm("full: full-only unit suite", "test:unit:full-only", [
	"--run",
	...vitestPolicy,
	"--sequence.seed=1",
	...fullOnlyUnit,
]);

const milestoneScripts = [
	"scripts/eval-selfhost-check.ts",
	"scripts/eval-strip-check.ts",
	"scripts/eval-phase2-check.ts",
];
assertCompleteSelection(
	"milestone checks",
	listFilesRecursively("scripts", (file) => /\/eval-.*-check\.ts$/.test(file)),
	milestoneScripts,
);

const test262FullMatrix: Array<Command> = [
	node("full: Test262 compiled normal corpus", "scripts/test262.ts", [
		"--canonical",
		"--backend",
		"compiled",
		"--mode",
		"normal",
		"--check",
		...runnerPolicy,
	]),
	node("full: Test262 GC high-risk spine", "scripts/test262.ts", [
		"--canonical",
		"--backend",
		"wire",
		"--mode",
		"gc-stress",
		"--manifest",
		"tests/test-suite-test262-gc.txt",
		"--variant",
		"strict",
		"--check",
		...runnerPolicy,
	]),
	node("full: Test262 GC sloppy-risk spine", "scripts/test262.ts", [
		"--canonical",
		"--backend",
		"wire",
		"--mode",
		"gc-stress",
		"--manifest",
		"tests/test-suite-test262-gc-sloppy.txt",
		"--variant",
		"sloppy",
		"--check",
		...runnerPolicy,
	]),
];

const remainingNativeCommands = nativeDimensionCommands("full: remaining", nativeFull);

const fullCommands: Array<Command> = [
	...selfHostedCommands,
	...checkMatrixCommands,
	fullOnlyUnitCommand,
	node("full: self-hosted compiler differential", milestoneScripts[0]!),
	node("full: source strip differential", milestoneScripts[1]!),
	node("full: wire loader differential", milestoneScripts[2]!),
	npm("full: Rust runtime unit suite", "test:rust"),
	...remainingNativeCommands,
	{
		...npm("full: non-generational GC", "test:native", [
			...vitestPolicy,
			"tests/native/gc.test.ts",
		]),
		env: { MAL_GC_GENERATIONAL: "0" },
	},
	{
		...npm("full: concurrent GC", "test:native", [
			...vitestPolicy,
			"tests/native/gc.test.ts",
		]),
		env: { MAL_GC_CONCURRENT: "1" },
	},
	npm("full: WPT compiled normal", "test:wpt", [
		"--canonical",
		"--mode",
		"normal",
		"--backend",
		"compiled",
		...runnerPolicy,
	]),
	npm("full: WPT focused GC verification", "test:wpt", [
		"--canonical",
		...selectionArgs(wptSmoke, "--test"),
		"--mode",
		"gc-stress",
		"--backend",
		"wire",
		...runnerPolicy,
	]),
	...test262FullMatrix,
	...(process.platform === "darwin"
		? [npm("full: leak audit", "test:leak", vitestPolicy)]
		: []),
];

const allLaterCommands =
	tier === "smoke"
		? []
		: tier === "check"
			? [...qualityCommands, ...checkMatrixCommands]
			: [...qualityCommands, ...fullCommands];

function assertUniqueCommands(commands: Array<Command>): void {
	const names = new Set<string>();
	const invocations = new Set<string>();
	for (const command of commands) {
		if (names.has(command.name)) throw new Error(`duplicate test stage: ${command.name}`);
		names.add(command.name);
		const invocation = formatCommand(command);
		if (invocations.has(invocation)) {
			throw new Error(`duplicate test invocation: ${invocation}`);
		}
		invocations.add(invocation);
	}
}

assertUniqueCommands([...allSmokeCommands, ...allLaterCommands]);
const included = (command: Command) => !excludeQuality || command.kind !== "quality";
const smokeCommands = allSmokeCommands.filter(included);
const laterCommands = allLaterCommands.filter(included);
const excludedStages = [...allSmokeCommands, ...allLaterCommands]
	.filter((command) => !included(command))
	.map((command) => command.name);
const scope = { coversEntireTier: excludedStages.length === 0, excludedStages };

if (list) {
	for (const command of [...smokeCommands, ...laterCommands]) {
		console.log(`${command.name}:\n  ${formatCommand(command)}`);
	}
	process.exit(0);
}

if (jsonPlan) {
	const commands = [...smokeCommands, ...laterCommands];
	console.log(
		JSON.stringify(
			{
				...commandEnvironmentPlan(
					mergeCommandRequirements(commands.map((command) => command.requirements)),
					{ approval: tier === "full" ? "explicit" : "none", workspace: root },
				),
				tier,
				policy,
				scope,
				test262Baseline,
				workers,
				smokeBudget: {
					nominalWorkers: NOMINAL_SMOKE_WORKERS,
					...smokeBudgetForWorkers(workers),
				},
				stages: commands.map((command) => ({
					kind: command.kind,
					name: command.name,
					invocation: formatCommand(command),
					requirements: command.requirements,
					workers: stageWorkers(command),
					environment: stageEnvironment(command),
				})),
			},
			null,
			2,
		),
	);
	process.exit(0);
}

const sharedCache = maligatorCacheDirectory();
const suiteReportDirectory = path.join(root, ".cache", "mal-build", "test-suite");
const telemetryRoot = path.join(suiteReportDirectory, `telemetry-${tier}-${process.pid}`);
const suiteReportPath = path.join(suiteReportDirectory, `report-${tier}.json`);
rmSync(telemetryRoot, { recursive: true, force: true });
mkdirSync(telemetryRoot, { recursive: true });
const suiteStartedAt = new Date();
const suiteStartedAtMs = performance.now();
const stageReports: Array<StageReport> = [];
function persistSuiteReport(complete: boolean): void {
	writeFileSync(
		suiteReportPath,
		`${JSON.stringify(
			{
				schemaVersion: 3,
				tier,
				policy,
				scope,
				test262Baseline,
				workers,
				startedAt: suiteStartedAt.toISOString(),
				durationMs: Math.round((performance.now() - suiteStartedAtMs) * 1000) / 1000,
				complete,
				stages: stageReports,
			},
			null,
			2,
		)}\n`,
	);
}
persistSuiteReport(false);
const smokeIdentity = hashDirectoryTreesCached(
	{
		root,
		directories: [path.join(root, "src"), path.join(root, "runtime")],
		include: (entry) => /\.(?:c|h|rs|ts|mts|json|toml)$/.test(entry.name),
		prefix: [
			process.platform,
			process.arch,
			process.version,
			readFileSync(path.join(root, "package-lock.json"), "utf8"),
			readFileSync(import.meta.filename, "utf8"),
		],
	},
	path.join(
		sharedCache,
		"source-digests",
		`test-suite-${hash("sha256", root, "hex").slice(0, 16)}.json`,
	),
	"test-suite-smoke-v1",
).digest;
const smokeStampPath = path.join(sharedCache, "test-suite-smoke.json");
let previousSmokeIdentity: string | undefined;
try {
	const stamp = JSON.parse(readFileSync(smokeStampPath, "utf8")) as {
		identity?: unknown;
	};
	if (typeof stamp.identity === "string") previousSmokeIdentity = stamp.identity;
} catch {
	// A missing or damaged stamp is conservatively cold.
}
const coldSmokeRun =
	previousSmokeIdentity !== smokeIdentity ||
	[
		path.join(sharedCache, "compiler-wire"),
		path.join(sharedCache, "actions", "runtime-archive"),
		path.join(sharedCache, "actions", "rust-library"),
		path.join(sharedCache, "actions", "generated-object"),
		path.join(sharedCache, "actions", "linked-binary"),
		path.join(sharedCache, "test262-program-images"),
		path.join(sharedCache, "frontend", "artifacts"),
		path.join(TEST262_METADATA.path, ".git"),
		path.join(sharedCache, "actions", "test262-input-index"),
	].some((entry) => !existsSync(entry));
// Cumulative gates must finish when earlier benchmark work evicts an exact artifact
// while leaving the coarse cache roots that the standalone warm probe can inspect.
const useColdSmokeBudget = coldSmokeRun || tier !== "smoke";
const smokeBudget = smokeBudgetForWorkers(workers);
const smokeFuseMs = useColdSmokeBudget ? smokeBudget.coldMs : smokeBudget.warmMs;

if (coldSmokeRun) {
	console.log(
		`[test-suite] cold caches detected; smoke fuse extended to ${formatCommandDuration(smokeFuseMs)}`,
	);
} else if (tier !== "smoke") {
	console.log(
		`[test-suite] cumulative gate uses ${formatCommandDuration(smokeFuseMs)} smoke completion budget`,
	);
}

let failures = 0;
const smokeStarted = Date.now();
const commands = [...smokeCommands, ...laterCommands];
const progress = new CommandProgress("test-suite");
progress.start(
	`${tier} ${scope.coversEntireTier ? "gate" : "selected stages"} · ${commands.length} stages · ${coldSmokeRun ? "cold" : useColdSmokeBudget ? "completion" : "warm"} smoke budget ${formatCommandDuration(smokeFuseMs)}`,
);
let stageIndex = 0;
for (const command of smokeCommands) {
	stageIndex++;
	if (policy === "bail" && Date.now() - smokeStarted >= smokeFuseMs) {
		console.error("[test-suite] smoke fuse expired before all stages started");
		persistSuiteReport(false);
		process.exit(1);
	}
	const stage = runCommand(
		command,
		progress,
		stageIndex,
		commands.length,
		path.join(telemetryRoot, String(stageIndex).padStart(2, "0")),
	);
	stageReports.push(stage);
	persistSuiteReport(false);
	if (stage.status !== 0) {
		failures++;
		if (policy === "bail") process.exit(1);
	}
}

if (Date.now() - smokeStarted > smokeFuseMs) {
	console.error(`[test-suite] smoke fuse exceeded ${smokeFuseMs / 1000}s`);
	failures++;
	if (policy === "bail") {
		persistSuiteReport(false);
		process.exit(1);
	}
}

if (failures === 0) {
	mkdirSync(path.dirname(smokeStampPath), { recursive: true });
	writeFileSync(smokeStampPath, `${JSON.stringify({ identity: smokeIdentity })}\n`);
}

for (const command of laterCommands) {
	stageIndex++;
	const stage = runCommand(
		command,
		progress,
		stageIndex,
		commands.length,
		path.join(telemetryRoot, String(stageIndex).padStart(2, "0")),
	);
	stageReports.push(stage);
	persistSuiteReport(false);
	if (stage.status !== 0) {
		failures++;
		if (policy === "bail") process.exit(1);
	}
}

if (failures > 0) {
	console.error(`\n[test-suite] ${failures} stage${failures === 1 ? "" : "s"} failed`);
	persistSuiteReport(true);
	process.exit(1);
}
progress.complete(`${tier} passed`);
persistSuiteReport(true);
