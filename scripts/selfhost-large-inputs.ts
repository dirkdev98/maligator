import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import {
	closeSync,
	openSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { artifactFileDigest } from "../src/artifact-store.ts";
import { largeDevelopmentSource } from "../tests/fixtures/selfhost-large-development/source.ts";
import { startDevelopmentDriver } from "./development-driver.ts";
import type { DevelopmentDriverExit } from "./development-driver.ts";

interface LargeInputCheckOptions {
	cli: string;
	project: string;
	reports: string;
	environment: NodeJS.ProcessEnv;
	toolchainFreeEnvironment: NodeJS.ProcessEnv;
	invoke(
		args: Array<string>,
		environment?: NodeJS.ProcessEnv,
		timeoutMs?: number,
	): SpawnSyncReturns<string>;
	checkProfile(directory: string, command: "run" | "test"): void;
	waitForOutput(read: () => string, expected: string, timeoutMs: number): Promise<void>;
}

export function checkLargeRootArtifacts(
	options: Pick<LargeInputCheckOptions, "cli" | "project" | "reports" | "environment">,
): void {
	const roots = 32;
	const literalUnits = 1024 * 1024;
	const literal = "x".repeat(literalUnits);
	const entries = Array.from(
		{ length: roots },
		(_, index) => `root-artifact-${index}.mts`,
	);
	for (const entry of entries)
		writeFileSync(
			path.join(options.project, entry),
			`export const value = "${literal}"; console.log(value);\n`,
		);
	writeFileSync(
		path.join(options.project, "root-artifacts-main.mts"),
		`import { createWorkerUrl } from "maligator:workers";\nexport const roots = [${entries.map((entry) => `createWorkerUrl("./${entry}", import.meta.url)`).join(",")}];\n`,
	);
	const config = "root-artifacts.build.mts";
	writeFileSync(
		path.join(options.project, config),
		`export default { entry: "root-artifacts-main.mts", engine: { eval: false, regexp: false, intl: { enabled: false } }, surface: { node: false, webPlatform: false } };\n`,
	);
	const output = path.join(options.reports, "root-artifacts.c");
	const errors = path.join(options.reports, "root-artifacts.stderr");
	const descriptors: Array<number> = [];
	try {
		descriptors.push(openSync(output, "w"));
		descriptors.push(openSync(errors, "w"));
		const startedAt = performance.now();
		const result = spawnSync(
			options.cli,
			[
				"build",
				"--config",
				config,
				"--production",
				"--print",
				"--compile-concurrency",
				"2",
			],
			{
				cwd: options.project,
				env: { ...options.environment, MALIGATOR_WORKERS: "2" },
				stdio: ["ignore", descriptors[0]!, descriptors[1]!],
				timeout: 300_000,
				killSignal: "SIGKILL",
			},
		);
		const stderr = readFileSync(errors, "utf8");
		writeFileSync(
			path.join(options.reports, "root-artifacts.json"),
			`${JSON.stringify({ roots, literalUnits, uncompressedConstantBytes: roots * literalUnits * 2 * 2, durationMs: performance.now() - startedAt, status: result.status, signal: result.signal, error: result.error?.message, generatedBytes: statSync(output).size, generatedSha256: artifactFileDigest(output), stderr }, null, 2)}\n`,
		);
		if (result.status !== 0 || result.signal !== null)
			throw new Error(`large root artifact publication failed:\n${stderr}`, {
				cause: result.error,
			});
		if (!stderr.includes("parallel roots"))
			throw new Error(
				`large root artifacts did not use the parallel compiler:\n${stderr}`,
			);
	} finally {
		for (const descriptor of descriptors) closeSync(descriptor);
		rmSync(output, { force: true });
		rmSync(errors, { force: true });
	}
}

/** Verify large-input handling through a packaged CLI in an owned test project. */
export async function checkLargeInputs(options: LargeInputCheckOptions): Promise<void> {
	const { project, reports } = options;
	const dependency = path.join(project, "large-dependency.mts");
	const revisionFile = path.join(project, "large-revision.mts");
	const entry = path.join(project, "large-main.mts");
	const config = "large-inputs.build.mts";
	const testFile = "large-inputs.test.mts";
	const dataLength = 40 * 1024 * 1024;
	writeFileSync(
		dependency,
		`/*${"x".repeat(40 * 1024 * 1024)}*/\n${largeDevelopmentSource()}`,
	);
	writeFileSync(
		path.join(project, "large-records.json"),
		JSON.stringify({ text: `${"x".repeat(dataLength)}é😀` }),
	);
	writeFileSync(
		path.join(project, config),
		`export default {
	entry: "large-main.mts",
	outputName: "selfhost-large-inputs",
	engine: { eval: false, regexp: false, intl: { enabled: false } },
	surface: { node: true },
};\n`,
	);
	writeFileSync(
		path.join(project, "large-data.mts"),
		`import { readFileSync } from "node:fs";
export function readData() {
	const source = readFileSync("large-records.json", "utf8");
	const parsed = JSON.parse(source);
	if (parsed.text.length !== ${dataLength + 3} || parsed.text.slice(-3) !== "é😀") throw new Error("large UTF-8 data mismatch");
	return parsed.text.length;
}\n`,
	);
	writeFileSync(
		entry,
		`import { calculate, operationCount } from "./large-dependency.mts";
import { readData } from "./large-data.mts";
import { revision } from "./large-revision.mts";
console.log("LARGE_INPUTS " + JSON.stringify([revision, calculate(0), calculate(operationCount - 1), readData()]));\n`,
	);
	const writeRevision = (revision: number, delta = 0) =>
		writeFileSync(
			revisionFile,
			`export const revision = ${revision};\nexport const delta = ${delta};\n`,
		);
	writeRevision(0);
	const expected = () => {
		const result = spawnSync(process.execPath, [entry], {
			cwd: project,
			encoding: "utf8",
			timeout: 30_000,
		});
		if (result.status !== 0)
			throw new Error(`large Node reference failed: ${result.stderr}`, {
				cause: result.error,
			});
		return result.stdout;
	};
	const initial = expected();
	const first = (
		JSON.parse(initial.trim().slice("LARGE_INPUTS ".length)) as Array<number>
	)[1]!;
	const invoke = (args: Array<string>, environment: NodeJS.ProcessEnv = {}) => {
		const result = options.invoke(args, environment, 300_000);
		if (result.status !== 0 || result.signal !== null)
			throw new Error(
				`large-input ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`,
				{ cause: result.error },
			);
		return result;
	};
	const buildArgs = ["build", "--config", config, "--verbose"];
	const runBuilt = (binary: string, output: string) => {
		const result = spawnSync(binary.trim(), [], {
			cwd: project,
			env: options.toolchainFreeEnvironment,
			encoding: "utf8",
			timeout: 30_000,
		});
		if (result.status !== 0 || result.stdout !== output)
			throw new Error(
				`large-input binary disagreed with Node:\n${result.stdout}\n${result.stderr}`,
				{ cause: result.error },
			);
	};
	const built = invoke(buildArgs).stdout;
	runBuilt(built, initial);
	const restored = invoke(buildArgs);
	if (restored.stdout !== built || !restored.stderr.includes("Binary cache: hit"))
		throw new Error("large development build did not restore its binary cache");
	runBuilt(restored.stdout, initial);
	for (let iteration = 0; iteration < 2; iteration++) {
		const run = invoke(["run", "--config", config], options.toolchainFreeEnvironment);
		if (run.stdout !== initial)
			throw new Error(`large run disagreed with Node: ${run.stdout}`);
	}
	writeFileSync(
		path.join(project, testFile),
		`import { expect, test } from "maligator:test";
import { calculate, operationCount } from "./large-dependency.mts";
import { readData } from "./large-data.mts";
import { revision, delta } from "./large-revision.mts";
let calls = 0;
test("large inputs", () => {
	expect(++calls).toBe(1);
	expect(calculate(0)).toBe(${first} + delta);
	expect(Number.isFinite(calculate(operationCount - 1))).toBe(true);
	expect(readData()).toBe(${dataLength + 3});
	console.log("LARGE_TEST_REVISION " + revision + " CALL " + calls);
});\n`,
	);
	for (let iteration = 0; iteration < 2; iteration++) {
		const result = invoke(
			["test", "--config", config, testFile],
			options.toolchainFreeEnvironment,
		);
		if (!result.stdout.includes("1 passed, 0 failed"))
			throw new Error(`large test did not pass: ${result.stdout}`);
	}
	writeFileSync(
		path.join(project, "large-dev.mts"),
		`import { createServer } from "node:http";
import { ready } from "maligator:application";
import { calculate } from "./large-dependency.mts";
import { readData } from "./large-data.mts";
import { revision, delta } from "./large-revision.mts";
if (calculate(0) !== ${first} + delta) throw new Error("stale large dependency");
readData();
const server = createServer((_request, response) => response.end(String(revision)));
server.listen(0, "127.0.0.1", () => { console.log("DX_HTTP_PORT " + server.address().port); ready(); });\n`,
	);
	const development = startDevelopmentDriver(
		options.cli,
		["dev", "large-dev.mts", "--status", "--config", config],
		{
			cwd: project,
			env: options.toolchainFreeEnvironment,
			readinessTimeoutMs: 180_000,
			shutdownGraceMs: 10_000,
			shutdownTimeoutMs: 15_000,
		},
	);
	let developmentExit: DevelopmentDriverExit;
	try {
		await development.waitForRevision(0);
		writeRevision(1);
		await development.waitForRevision(1);
		const edited = `/*${"x".repeat(40 * 1024 * 1024)}*/\n${largeDevelopmentSource().replace("return value;", "return value + 1;")}`;
		writeFileSync(dependency, edited);
		writeRevision(2, 1);
		await development.waitForRevision(2);
	} finally {
		developmentExit = await development.stop();
		writeFileSync(
			path.join(reports, "large-dev.json"),
			`${JSON.stringify(developmentExit, null, 2)}\n`,
		);
	}
	if (
		developmentExit.code !== 0 ||
		developmentExit.signal !== null ||
		developmentExit.forced
	)
		throw new Error(
			`large dev did not stop cleanly: ${JSON.stringify({ code: developmentExit.code, signal: developmentExit.signal, forced: developmentExit.forced, shutdownMs: developmentExit.shutdownMs })}`,
		);
	const watch = startDevelopmentDriver(
		options.cli,
		["test", "--watch", "--status", "--config", config, testFile],
		{
			cwd: project,
			env: options.toolchainFreeEnvironment,
			shutdownGraceMs: 10_000,
			shutdownTimeoutMs: 15_000,
		},
	);
	let watchExit: DevelopmentDriverExit;
	try {
		await options.waitForOutput(
			() => watch.output,
			"LARGE_TEST_REVISION 2 CALL 1",
			180_000,
		);
		await options.waitForOutput(() => watch.output, "0 failed;", 180_000);
		const beforeRerun = { stdout: watch.stdout.length, stderr: watch.stderr.length };
		const rerunOutput = () =>
			`${watch.stdout.slice(beforeRerun.stdout)}\n${watch.stderr.slice(beforeRerun.stderr)}`;
		process.kill(watch.pid!, "SIGHUP");
		await options.waitForOutput(rerunOutput, "LARGE_TEST_REVISION 2 CALL 1", 180_000);
		await options.waitForOutput(rerunOutput, "0 failed;", 180_000);
		const beforeEdit = { stdout: watch.stdout.length, stderr: watch.stderr.length };
		const editedOutput = () =>
			`${watch.stdout.slice(beforeEdit.stdout)}\n${watch.stderr.slice(beforeEdit.stderr)}`;
		writeRevision(3, 1);
		await options.waitForOutput(editedOutput, "LARGE_TEST_REVISION 3 CALL 1", 180_000);
		await options.waitForOutput(editedOutput, "0 failed;", 180_000);
	} finally {
		watchExit = await watch.stop();
		writeFileSync(
			path.join(reports, "large-test-watch.json"),
			`${JSON.stringify(watchExit, null, 2)}\n`,
		);
	}
	if (watchExit.code !== 0 || watchExit.signal !== null || watchExit.forced)
		throw new Error(
			`large test watch did not stop cleanly: ${JSON.stringify({ code: watchExit.code, signal: watchExit.signal, forced: watchExit.forced, shutdownMs: watchExit.shutdownMs })}`,
		);
	const editedExpected = expected();
	runBuilt(invoke(buildArgs).stdout, editedExpected);
	const dump = path.join(reports, "large-generated.c");
	const descriptor = openSync(dump, "w");
	let generatedBytes: number;
	let generatedSha256: string;
	try {
		// Populate the production frontend cache before linking so each phase has a bounded check.
		const args = [...buildArgs, "--production", "--print"];
		const startedAt = performance.now();
		const result = spawnSync(options.cli, args, {
			cwd: project,
			env: options.environment,
			stdio: ["ignore", descriptor, "pipe"],
			encoding: "utf8",
			timeout: 300_000,
			killSignal: "SIGKILL",
			maxBuffer: 8 * 1024 * 1024,
		});
		writeFileSync(
			path.join(reports, "large-print.json"),
			`${JSON.stringify({ args, durationMs: performance.now() - startedAt, status: result.status, signal: result.signal, error: result.error?.message, stderr: result.stderr }, null, 2)}\n`,
		);
		if (result.status !== 0)
			throw new Error(`large C dump failed: ${result.stderr}`, { cause: result.error });
		generatedBytes = statSync(dump).size;
		if (generatedBytes <= 32 * 1024 * 1024)
			throw new Error("large fixture did not exercise aggregate generated output");
		generatedSha256 = artifactFileDigest(dump);
	} finally {
		closeSync(descriptor);
		rmSync(dump, { force: true });
	}
	runBuilt(invoke(["build", "--config", config, "--production"]).stdout, editedExpected);
	for (const command of ["run", "test"] as const) {
		const directory = path.join(reports, `large-profile-${command}`);
		const result = invoke(
			[
				command,
				"--profile",
				"--config",
				config,
				...(command === "test" ? [testFile] : []),
			],
			{ MALIGATOR_PROFILE_DIRECTORY: directory },
		);
		if (
			command === "run"
				? result.stdout !== editedExpected
				: !result.stdout.includes("1 passed, 0 failed")
		)
			throw new Error(
				`large ${command} profile lost observable output: ${result.stdout}`,
			);
		options.checkProfile(directory, command);
	}
	writeFileSync(
		path.join(reports, "large-inputs.json"),
		`${JSON.stringify({ sourceBytes: statSync(dependency).size, sourceSha256: artifactFileDigest(dependency), generatedBytes, generatedSha256, commands: ["build", "run", "dev", "test", "test --watch", "build --production --print", "build --production", "run --profile", "test --profile"], edits: ["small dependency", "large dependency"], cacheRestoration: true }, null, 2)}\n`,
	);
	checkLargeRootArtifacts(options);
	console.log(
		"ok   large sources, UTF-8 data and generated output survived command execution, edits and cache restoration",
	);
}
