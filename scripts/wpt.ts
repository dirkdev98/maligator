import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { buildDerivationFromConfig, resolveBuildConfig } from "../src/build-config.ts";
import {
	BuildCompilationSession,
	compileBuildFrontend,
} from "../src/build-frontend-cache.ts";
import { CommandProgress } from "../src/command-progress.ts";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { buildDevelopmentRunner } from "../src/local-build.ts";
import { resolveNativeBuildContext } from "../src/native-build-context.ts";
import { buildNativeBinary } from "../src/test-harness.ts";
import {
	classifyWptResults,
	createWptExecutionEnvironment,
	createWptProgram,
	loadPinnedWptTest,
	parseWptExpectations,
	parseWptManifest,
	parseWptOutput,
	parseWptPolicy,
	selectWptExecutionDimensions,
	selectWptManifestEntries,
	shouldAbortWptRun,
	validateWptExpectations,
	verifyWptCheckout,
} from "../tests/wpt/harness.ts";
import type {
	WptExecutionKey,
	WptExpectation,
	WptHarnessResult,
	WptSubtestResult,
} from "../tests/wpt/harness.ts";
import { reexecWithCleanTestEnvironment } from "./test-environment.ts";

const root = path.resolve(import.meta.dirname, "..");
const metadataRoot = path.join(root, "tests/wpt");
const externalRoot = process.env.WPT_ROOT;
const checkoutRoot = externalRoot
	? path.resolve(externalRoot)
	: path.join(metadataRoot, "fixtures/wpt");
const outputRoot = path.join(root, ".cache/wpt");
const buildRoot = path.join(outputRoot, "build");
const resultsPath = path.join(outputRoot, "results.json");

const requestedPaths: Array<string> = [];
const requestedModes: Array<string> = [];
const requestedBackends: Array<string> = [];
let requestedPolicy: string | undefined;
let canonical = false;
let keepArtifacts = false;
const usage =
	"usage: npm run test:wpt -- [--canonical] [--keep-artifacts] [--test <curated-path>]... [--mode normal|gc-stress]... [--backend compiled|interpreted|wire]... [--policy bail|complete]";
for (let index = 2; index < process.argv.length; index++) {
	const option = process.argv[index];
	if (option === "-h" || option === "--help") {
		console.log(usage);
		process.exit(0);
	}
	if (option === "--canonical") {
		if (canonical) throw new Error(`--canonical may only be specified once\n${usage}`);
		canonical = true;
		continue;
	}
	if (option === "--keep-artifacts") {
		if (keepArtifacts)
			throw new Error(`--keep-artifacts may only be specified once\n${usage}`);
		keepArtifacts = true;
		continue;
	}
	const value = process.argv[index + 1];
	if (value === undefined || value.startsWith("--")) {
		throw new Error(usage);
	}
	if (option === "--test") requestedPaths.push(value);
	else if (option === "--mode") requestedModes.push(value);
	else if (option === "--backend") requestedBackends.push(value);
	else if (option === "--policy" && requestedPolicy === undefined)
		requestedPolicy = value;
	else throw new Error(usage);
	index++;
}
if (canonical) reexecWithCleanTestEnvironment("WPT_CANONICAL_CHILD");
const policy = parseWptPolicy(requestedPolicy);

const manifest = parseWptManifest(
	readFileSync(path.join(metadataRoot, "curated.json"), "utf8"),
);
const allExpectations = parseWptExpectations(
	readFileSync(path.join(metadataRoot, "expectations.json"), "utf8"),
);
validateWptExpectations(allExpectations, manifest.tests);

verifyWptCheckout(checkoutRoot, externalRoot !== undefined);
const pinnedTests = new Map(
	manifest.tests.map((entry) => [entry.path, loadPinnedWptTest(checkoutRoot, entry)]),
);
const tests = selectWptManifestEntries(manifest.tests, requestedPaths);
const dimensions = new Map(
	tests.map((entry) => [
		entry.path,
		selectWptExecutionDimensions(entry, requestedModes, requestedBackends),
	]),
);

const executionKeys = new Set<string>();
for (const entry of tests) {
	const pinned = pinnedTests.get(entry.path);
	if (pinned === undefined)
		throw new Error(`missing loaded WPT source for ${entry.path}`);
	for (const variant of pinned.metadata.variants) {
		for (const dimension of dimensions.get(entry.path) ?? []) {
			executionKeys.add(
				[entry.path, variant, dimension.backend, dimension.mode].join("\0"),
			);
		}
	}
}
const plannedExecutions = executionKeys.size;
const progress = new CommandProgress("wpt");
progress.start(
	`${tests.length} files · ${plannedExecutions} executions · ${policy} policy`,
);
progress.stage(1, 2, "prepare pinned fixtures and expectations");
const expectations = allExpectations.filter((expectation) =>
	executionKeys.has(
		[expectation.path, expectation.variant, expectation.backend, expectation.mode].join(
			"\0",
		),
	),
);
progress.stagePassed(1, 2, "prepare pinned fixtures and expectations");

const wireConfig = resolveBuildConfig({
	engine: {
		eval: false,
		realms: false,
		regexp: true,
		temporal: false,
		intl: { enabled: false },
		primordials: "mutable",
	},
	surface: { webPlatform: true },
});
const wireDerivation = buildDerivationFromConfig(wireConfig);
const wireSession = new BuildCompilationSession();
wireSession.useCacheDirectory();
const wireRunner = requestedBackends.includes("wire")
	? buildDevelopmentRunner(
			resolveNativeBuildContext({ features: wireDerivation.features }),
			false,
			wireDerivation.cacheSuffix,
		).binaryPath
	: undefined;

function childErrorCode(error: Error | undefined): string | undefined {
	if (error === undefined || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function executionExpectations(
	execution: WptExecutionKey,
	items: Array<WptExpectation>,
): Array<WptExpectation> {
	return items.filter(
		(item) =>
			item.path === execution.path &&
			item.variant === execution.variant &&
			item.backend === execution.backend &&
			item.mode === execution.mode,
	);
}

interface ExecutionReport extends WptExecutionKey {
	target: "server-main";
	harness: WptHarnessResult;
	process: {
		exitStatus: number | null;
		signal: NodeJS.Signals | null;
		timedOut: boolean;
		error: string | null;
		stdout: string;
		stderr: string;
	};
	results: Array<WptSubtestResult>;
	verdicts: ReturnType<typeof classifyWptResults>["results"];
	missingExpectations: Array<WptExpectation>;
}

mkdirSync(buildRoot, { recursive: true });
if (!keepArtifacts) {
	process.once("exit", () => rmSync(buildRoot, { recursive: true, force: true }));
}
const executions: Array<ExecutionReport> = [];
let aborted = false;
progress.stage(2, 2, "build and execute WPT selection");
for (const entry of tests) {
	const manifestIndex = manifest.tests.indexOf(entry);
	const pinned = pinnedTests.get(entry.path);
	if (pinned === undefined)
		throw new Error(`missing loaded WPT source for ${entry.path}`);
	for (const [variantIndex, variant] of pinned.metadata.variants.entries()) {
		const generatedPath = path.join(buildRoot, `wpt-${manifestIndex}-${variantIndex}.js`);
		const generatedSource = createWptProgram(entry, pinned, variant);
		if (
			!existsSync(generatedPath) ||
			readFileSync(generatedPath, "utf8") !== generatedSource
		) {
			writeFileSync(generatedPath, generatedSource);
		}
		const entryDimensions = dimensions.get(entry.path) ?? [];
		for (const backend of new Set(entryDimensions.map((item) => item.backend))) {
			progress.detail(`${entry.path} · ${variant || "default"} · ${backend} build`);
			let binary: string;
			let binaryArguments: Array<string> = [];
			try {
				if (backend === "wire") {
					if (wireRunner === undefined) throw new Error("wire runtime was not prepared");
					const wirePath = path.join(
						buildRoot,
						`wpt-${manifestIndex}-${variantIndex}.malw`,
					);
					const wireFrontend = compileBuildFrontend({
						entrypoint: generatedPath,
						config: wireConfig,
						stripTypes: stripCompactTypes,
						stripperIdentity: "wpt-wire-v1",
						optimization: "development",
						session: wireSession,
					});
					progress.detail(`${entry.path} · wire frontend cache ${wireFrontend.cache}`);
					writeFileSync(wirePath, wireFrontend.wire);
					binary = wireRunner;
					binaryArguments = [wirePath];
				} else {
					binary = buildNativeBinary({
						fixture: generatedPath,
						name: `wpt-${manifestIndex}-${variantIndex}-${backend}`,
						mainFile: "runtime/host_main.c",
						outDir: buildRoot,
						compiled: backend === "compiled",
					});
				}
			} catch (error) {
				for (const { mode } of entryDimensions.filter(
					(item) => item.backend === backend,
				)) {
					const execution = { path: entry.path, variant, backend, mode };
					const classified = classifyWptResults(
						[],
						executionExpectations(execution, expectations),
					);
					const report: ExecutionReport = {
						...execution,
						target: "server-main",
						harness: {
							path: entry.path,
							status: "ERROR",
							total: 0,
							message: `build failed: ${error instanceof Error ? error.message : String(error)}`,
						},
						process: {
							exitStatus: null,
							signal: null,
							timedOut: false,
							error: error instanceof Error ? error.message : String(error),
							stdout: "",
							stderr: "",
						},
						results: [],
						verdicts: [],
						missingExpectations: classified.missing,
					};
					executions.push(report);
					progress.progress(
						executions.length,
						plannedExecutions,
						`${entry.path} · ${backend}/${mode}`,
					);
					if (shouldAbortWptRun(policy, report)) {
						aborted = true;
						break;
					}
				}
				if (aborted) break;
				continue;
			}
			for (const { mode } of entryDimensions.filter((item) => item.backend === backend)) {
				const execution: WptExecutionKey = { path: entry.path, variant, backend, mode };
				const child = spawnSync(binary, binaryArguments, {
					encoding: "utf8",
					env: createWptExecutionEnvironment(process.env, mode),
					timeout: 120_000,
				});
				const timedOut = childErrorCode(child.error) === "ETIMEDOUT";
				const terminalStatus = timedOut
					? "TIMEOUT"
					: child.status === 0
						? undefined
						: "CRASH";
				let parsed: ReturnType<typeof parseWptOutput>;
				try {
					parsed = parseWptOutput(child.stdout, execution, terminalStatus);
				} catch (error) {
					parsed = {
						subtests: [],
						harness: {
							path: entry.path,
							status: "ERROR",
							total: 0,
							message: `malformed harness transport: ${error instanceof Error ? error.message : String(error)}`,
						},
					};
				}
				const classified = classifyWptResults(
					parsed.subtests,
					executionExpectations(execution, expectations),
				);
				const report: ExecutionReport = {
					...execution,
					target: "server-main",
					harness: parsed.harness,
					process: {
						exitStatus: child.status,
						signal: child.signal,
						timedOut,
						error: child.error?.message ?? null,
						stdout: child.stdout,
						stderr: child.stderr,
					},
					results: parsed.subtests,
					verdicts: classified.results,
					missingExpectations: classified.missing,
				};
				executions.push(report);
				progress.progress(
					executions.length,
					plannedExecutions,
					`${entry.path} · ${backend}/${mode}`,
				);
				if (shouldAbortWptRun(policy, { ...report, terminalStatus })) {
					aborted = true;
					break;
				}
			}
			if (aborted) break;
		}
		if (aborted) break;
	}
	if (aborted) break;
}

const unexpected = executions.flatMap((execution) =>
	execution.verdicts.filter((result) => result.verdict === "UNEXPECTED"),
);
const missing = executions.flatMap((execution) => execution.missingExpectations);
const harnessErrors = executions.filter(
	(execution) => execution.harness.status === "ERROR",
);
const report = {
	schemaVersion: 2,
	revision: manifest.revision,
	target: "server-main" as const,
	policy,
	complete: !aborted,
	aborted,
	executions,
	summary: {
		plannedExecutions,
		completedExecutions: executions.length,
		executions: executions.length,
		subtests: executions.reduce(
			(total, execution) => total + execution.results.length,
			0,
		),
		unexpected: unexpected.length,
		missingExpectations: missing.length,
		harnessErrors: harnessErrors.length,
	},
};
writeFileSync(resultsPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(
	`WPT: ${report.summary.completedExecutions}/${report.summary.plannedExecutions} executions, ${report.summary.subtests} subtests, ${report.summary.unexpected} unexpected, ${report.summary.missingExpectations} stale expectations, ${report.summary.harnessErrors} harness errors${aborted ? " (aborted)" : ""}`,
);
if (aborted || unexpected.length > 0 || missing.length > 0 || harnessErrors.length > 0) {
	progress.stageFailed(2, 2, "build and execute WPT selection");
	progress.failed();
	process.exitCode = 1;
} else {
	progress.stagePassed(
		2,
		2,
		"build and execute WPT selection",
		`${report.summary.subtests} subtests`,
	);
	progress.complete();
}
