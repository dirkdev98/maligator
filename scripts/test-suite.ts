import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { CommandProgress, formatCommandDuration } from "../src/command-progress.ts";
import { hashDirectoryTrees } from "../src/file-tree.ts";
import { cleanTestEnvironment } from "./test-environment.ts";

type Tier = "smoke" | "check" | "full";
type Policy = "bail" | "complete";

interface Command {
	name: string;
	command: string;
	args: Array<string>;
	env?: NodeJS.ProcessEnv;
}

const root = path.resolve(import.meta.dirname, "..");
const smokeIdentity = hashDirectoryTrees({
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
});
const smokeStampPath = path.join(root, ".cache/mal-cache/test-suite-smoke.json");
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
		".cache/mal-cache/compiler-wire",
		".cache/mal-cache/runtime",
		".cache/mal-cache/rust",
		".cache/mal-cache/test262-artifacts",
		".cache/test262/.git",
		".cache/test262-cache.json",
	].some((entry) => !existsSync(path.join(root, entry)));
const smokeFuseMs = coldSmokeRun ? 60_000 : 20_000;
const usage = `usage: node scripts/test-suite.ts [smoke|check|full] [options]

Tiers are cumulative: check starts with smoke; full starts with smoke and check.

Commands:
  npm run test:smoke          20-second warm / 60-second cold fail-fast fuse
  npm run test:check          approximately two-minute default developer gate
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
  --list                  print the exact commands without running them
  -h, --help              show this help

Pass --list through a tier command, for example npm run test:check -- --list.`;

function exitWithUsage(message?: string): never {
	if (message !== undefined) console.error(message);
	console.log(usage);
	process.exit(message === undefined ? 0 : 1);
}

function parseArguments(): { tier: Tier; policy: Policy; list: boolean } {
	let tier: Tier = "check";
	let tierSeen = false;
	let policy: Policy = "bail";
	let policySeen = false;
	let list = false;
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
		if (argument === "--list") {
			if (list) exitWithUsage("--list may only be specified once");
			list = true;
			continue;
		}
		exitWithUsage(`unknown argument: ${argument}`);
	}
	return { tier, policy, list };
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

function npm(name: string, script: string, args: Array<string> = []): Command {
	return {
		name,
		command: "npm",
		args: ["run", script, ...(args.length > 0 ? ["--", ...args] : [])],
	};
}

function node(name: string, script: string, args: Array<string> = []): Command {
	return { name, command: process.execPath, args: [script, ...args] };
}

function shellArgument(value: string): string {
	return /^[\w./:=+-]+$/.test(value) ? value : JSON.stringify(value);
}

function formatCommand(command: Command): string {
	const environment = Object.entries(command.env ?? {})
		.map(([name, value]) => `${name}=${shellArgument(value ?? "")}`)
		.join(" ");
	const invocation = [command.command, ...command.args].map(shellArgument).join(" ");
	return environment.length === 0 ? invocation : `${environment} ${invocation}`;
}

function selectionArgs(entries: Array<string>, option: string): Array<string> {
	return entries.flatMap((entry) => [option, entry]);
}

function runCommand(
	command: Command,
	progress: CommandProgress,
	current: number,
	total: number,
): boolean {
	progress.stage(current, total, command.name);
	const result = spawnSync(command.command, command.args, {
		cwd: root,
		env: cleanTestEnvironment(command.env),
		stdio: "inherit",
	});
	if (result.status === 0) {
		progress.stagePassed(current, total, command.name);
		return true;
	}
	if (result.error?.message) console.error(`[test-suite] ${result.error.message}`);
	else if (result.signal) console.error(`[test-suite] terminated by ${result.signal}`);
	else console.error(`[test-suite] exited with status ${result.status ?? "unknown"}`);
	progress.stageFailed(current, total, command.name);
	return false;
}

const { tier, policy, list } = parseArguments();
const fullOnlyUnit = readManifest("tests/test-suite-unit-full-only.txt");
const unitSmoke = readManifest("tests/test-suite-unit-smoke.txt");
const nativeSmoke = readManifest("tests/test-suite-native-smoke.txt");
const nativeCheck = readManifest("tests/test-suite-native-check.txt");
const test262Smoke = readManifest("tests/test-suite-test262-smoke.txt");
const test262Check = readManifest("tests/test-suite-test262-check.txt");
const wptSmoke = readManifest("tests/test-suite-wpt-smoke.txt");
const wptCheck = readManifest("tests/test-suite-wpt-check.txt");
assertDisjoint("native smoke/check", nativeSmoke, nativeCheck);
assertDisjoint("Test262 smoke/check", test262Smoke, test262Check);
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
const reservedNative = new Set([
	...nativeSmoke,
	...nativeCheck,
	"tests/native/leak.test.ts",
]);
for (const entry of reservedNative) {
	if (!allNative.includes(entry)) throw new Error(`unknown native selection: ${entry}`);
}
const nativeFull = allNative.filter((entry) => !reservedNative.has(entry));
const runnerPolicy = ["--policy", policy];
const vitestPolicy = policy === "bail" ? ["--bail=1"] : [];

const smokeCommands: Array<Command> = [
	npm("smoke: TypeScript", "type-check"),
	npm("smoke: fast unit suite", "test:unit", [
		"--run",
		...vitestPolicy,
		"--sequence.seed=1",
		...unitSmoke,
	]),
	npm("smoke: native runtime", "test:native", [...vitestPolicy, ...nativeSmoke]),
	node("smoke: Test262 cross-section", "scripts/test262.ts", [
		"--canonical",
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
		"compiled",
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
	npm("check: native complement", "test:native", [...vitestPolicy, ...nativeCheck]),
	node("check: Test262 regression complement", "scripts/test262.ts", [
		"--canonical",
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
		"compiled",
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

const fullOnlyUnitCommand = npm("full: full-only unit suite", "test:unit", [
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
	node("full: Test262 compiled", "scripts/test262.ts", [
		"--canonical",
		"--backend",
		"compiled",
		"--mode",
		"normal",
		"--exclude-manifest",
		"tests/test-suite-test262-smoke.txt",
		"--exclude-manifest",
		"tests/test-suite-test262-check.txt",
		"--check",
		...runnerPolicy,
	]),
	node("full: Test262 interpreted", "scripts/test262.ts", [
		"--canonical",
		"--backend",
		"interpreted",
		"--mode",
		"normal",
		"--check",
		...runnerPolicy,
	]),
	node("full: Test262 compiled GC verification", "scripts/test262.ts", [
		"--canonical",
		"--backend",
		"compiled",
		"--mode",
		"gc-stress",
		"--check",
		...runnerPolicy,
	]),
	node("full: Test262 interpreted GC verification", "scripts/test262.ts", [
		"--canonical",
		"--backend",
		"interpreted",
		"--mode",
		"gc-stress",
		"--check",
		...runnerPolicy,
	]),
];

const remainingNativeCommands: Array<Command> =
	nativeFull.length === 0
		? []
		: [
				npm("full: remaining native suite", "test:native", [
					...vitestPolicy,
					...nativeFull,
				]),
			];

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
	npm("full: sanitizer suite", "test:sanitize", vitestPolicy),
	npm("full: WPT compiled GC verification", "test:wpt", [
		"--canonical",
		"--mode",
		"gc-stress",
		"--backend",
		"compiled",
		...runnerPolicy,
	]),
	npm("full: WPT interpreted", "test:wpt", [
		"--canonical",
		"--mode",
		"normal",
		"--backend",
		"interpreted",
		...runnerPolicy,
	]),
	npm("full: WPT interpreted GC verification", "test:wpt", [
		"--canonical",
		"--mode",
		"gc-stress",
		"--backend",
		"interpreted",
		...runnerPolicy,
	]),
	...test262FullMatrix,
	...(process.platform === "darwin"
		? [npm("full: leak audit", "test:leak", vitestPolicy)]
		: []),
];

const laterCommands =
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

assertUniqueCommands([...smokeCommands, ...laterCommands]);

if (list) {
	for (const command of [...smokeCommands, ...laterCommands]) {
		console.log(`${command.name}:\n  ${formatCommand(command)}`);
	}
	process.exit(0);
}

if (coldSmokeRun) {
	console.log("[test-suite] cold caches detected; smoke fuse extended to 60s");
}

let failures = 0;
const smokeStarted = Date.now();
const commands = [...smokeCommands, ...laterCommands];
const progress = new CommandProgress("test-suite");
progress.start(
	`${tier} gate · ${commands.length} stages · ${coldSmokeRun ? "cold" : "warm"} smoke budget ${formatCommandDuration(smokeFuseMs)}`,
);
let stageIndex = 0;
for (const command of smokeCommands) {
	stageIndex++;
	if (policy === "bail" && Date.now() - smokeStarted >= smokeFuseMs) {
		console.error("[test-suite] smoke fuse expired before all stages started");
		process.exit(1);
	}
	if (!runCommand(command, progress, stageIndex, commands.length)) {
		failures++;
		if (policy === "bail") process.exit(1);
	}
}

if (Date.now() - smokeStarted > smokeFuseMs) {
	console.error(`[test-suite] smoke fuse exceeded ${smokeFuseMs / 1000}s`);
	failures++;
	if (policy === "bail") process.exit(1);
}

if (failures === 0) {
	mkdirSync(path.dirname(smokeStampPath), { recursive: true });
	writeFileSync(smokeStampPath, `${JSON.stringify({ identity: smokeIdentity })}\n`);
}

for (const command of laterCommands) {
	stageIndex++;
	if (!runCommand(command, progress, stageIndex, commands.length)) {
		failures++;
		if (policy === "bail") process.exit(1);
	}
}

if (failures > 0) {
	console.error(`\n[test-suite] ${failures} stage${failures === 1 ? "" : "s"} failed`);
	process.exit(1);
}
progress.complete(`${tier} passed`);
