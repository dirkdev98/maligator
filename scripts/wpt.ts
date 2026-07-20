import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { buildNativeBinary } from "../src/test-harness.ts";
import {
	classifyWptResults,
	createWptExecutionEnvironment,
	createWptProgram,
	loadPinnedWptTest,
	parseWptExpectations,
	parseWptManifest,
	parseWptOutput,
	selectWptExecutionDimensions,
	selectWptManifestEntries,
	verifyWptCheckout,
} from "../tests/wpt/harness.ts";
import type {
	WptExecutionKey,
	WptExpectation,
	WptHarnessResult,
	WptSubtestResult,
} from "../tests/wpt/harness.ts";

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
for (let index = 2; index < process.argv.length; index++) {
	const option = process.argv[index];
	const value = process.argv[index + 1];
	if (value === undefined || value.startsWith("--")) {
		throw new Error(
			"usage: npm run test:wpt -- [--test <curated-path>]... [--mode normal|gc-stress]... [--backend compiled|interpreted]...",
		);
	}
	if (option === "--test") requestedPaths.push(value);
	else if (option === "--mode") requestedModes.push(value);
	else if (option === "--backend") requestedBackends.push(value);
	else {
		throw new Error(
			"usage: npm run test:wpt -- [--test <curated-path>]... [--mode normal|gc-stress]... [--backend compiled|interpreted]...",
		);
	}
	index++;
}

const manifest = parseWptManifest(
	readFileSync(path.join(metadataRoot, "curated.json"), "utf8"),
);
const tests = selectWptManifestEntries(manifest.tests, requestedPaths);
const dimensions = new Map(
	tests.map((entry) => [
		entry.path,
		selectWptExecutionDimensions(entry, requestedModes, requestedBackends),
	]),
);
const allExpectations = parseWptExpectations(
	readFileSync(path.join(metadataRoot, "expectations.json"), "utf8"),
);

verifyWptCheckout(checkoutRoot, externalRoot !== undefined);
const pinnedTests = new Map(
	tests.map((entry) => [entry.path, loadPinnedWptTest(checkoutRoot, entry)]),
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
const expectations = allExpectations.filter((expectation) =>
	executionKeys.has(
		[expectation.path, expectation.variant, expectation.backend, expectation.mode].join(
			"\0",
		),
	),
);

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
const executions: Array<ExecutionReport> = [];
for (const entry of tests) {
	const manifestIndex = manifest.tests.indexOf(entry);
	const pinned = pinnedTests.get(entry.path);
	if (pinned === undefined)
		throw new Error(`missing loaded WPT source for ${entry.path}`);
	for (const [variantIndex, variant] of pinned.metadata.variants.entries()) {
		const generatedPath = path.join(buildRoot, `wpt-${manifestIndex}-${variantIndex}.js`);
		writeFileSync(generatedPath, createWptProgram(entry, pinned, variant));
		const entryDimensions = dimensions.get(entry.path) ?? [];
		for (const backend of new Set(entryDimensions.map((item) => item.backend))) {
			let binary: string;
			try {
				binary = buildNativeBinary({
					fixture: generatedPath,
					name: `wpt-${manifestIndex}-${variantIndex}-${backend}`,
					mainFile: "runtime/host_main.c",
					outDir: buildRoot,
					compiled: backend === "compiled",
				});
			} catch (error) {
				for (const { mode } of entryDimensions.filter(
					(item) => item.backend === backend,
				)) {
					const execution = { path: entry.path, variant, backend, mode };
					const classified = classifyWptResults(
						[],
						executionExpectations(execution, expectations),
					);
					executions.push({
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
					});
				}
				continue;
			}
			for (const { mode } of entryDimensions.filter((item) => item.backend === backend)) {
				const execution: WptExecutionKey = { path: entry.path, variant, backend, mode };
				const child = spawnSync(binary, [], {
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
				executions.push({
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
				});
			}
		}
	}
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
	executions,
	summary: {
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
	`WPT: ${report.summary.executions} executions, ${report.summary.subtests} subtests, ${report.summary.unexpected} unexpected, ${report.summary.missingExpectations} stale expectations, ${report.summary.harnessErrors} harness errors`,
);
if (unexpected.length > 0 || missing.length > 0 || harnessErrors.length > 0) {
	process.exitCode = 1;
}
