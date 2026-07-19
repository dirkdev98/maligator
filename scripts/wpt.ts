import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { buildNativeBinary } from "../src/test-harness.ts";
import {
	classifyWptResults,
	createWptExecutionEnvironment,
	createWptProgram,
	loadPinnedWptSource,
	parseWptExpectations,
	parseWptManifest,
	parseWptOutput,
	verifyWptCheckout,
} from "../tests/wpt/harness.ts";
import type { WptSubtestResult } from "../tests/wpt/harness.ts";

const root = path.resolve(import.meta.dirname, "..");
const metadataRoot = path.join(root, "tests/wpt");
const externalRoot = process.env.WPT_ROOT;
const checkoutRoot = externalRoot
	? path.resolve(externalRoot)
	: path.join(metadataRoot, "fixtures/wpt");
const outputRoot = path.join(root, ".cache/wpt");
const buildRoot = path.join(outputRoot, "build");
const resultsPath = path.join(outputRoot, "results.json");
rmSync(resultsPath, { force: true });
const manifest = parseWptManifest(
	readFileSync(path.join(metadataRoot, "curated.json"), "utf8"),
);
const expectations = parseWptExpectations(
	readFileSync(path.join(metadataRoot, "expectations.json"), "utf8"),
);

function childErrorCode(error: Error | undefined): string | undefined {
	if (error === undefined || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

verifyWptCheckout(checkoutRoot, externalRoot !== undefined);
mkdirSync(buildRoot, { recursive: true });

const results: Array<WptSubtestResult & { mode: "normal" | "gc-stress" }> = [];
for (const [index, entry] of manifest.tests.entries()) {
	const source = loadPinnedWptSource(checkoutRoot, entry);
	const generatedPath = path.join(buildRoot, `wpt-${index}.js`);
	writeFileSync(generatedPath, createWptProgram(entry.path, source));
	const binary = buildNativeBinary({
		fixture: generatedPath,
		name: `wpt-${index}`,
		mainFile: "runtime/host_main.c",
		outDir: buildRoot,
	});
	const modes = entry.gcStress
		? (["normal", "gc-stress"] as const)
		: (["normal"] as const);
	for (const mode of modes) {
		const execution = spawnSync(binary, [], {
			encoding: "utf8",
			env: createWptExecutionEnvironment(process.env, mode === "gc-stress"),
			timeout: 120_000,
		});
		const timedOut = childErrorCode(execution.error) === "ETIMEDOUT";
		const terminalStatus = timedOut
			? "TIMEOUT"
			: execution.status === 0
				? undefined
				: "CRASH";
		const parsed = parseWptOutput(execution.stdout, entry.path, terminalStatus);
		for (const subtest of parsed.subtests) results.push({ ...subtest, mode });
	}
}

const normalResults = results.filter((result) => result.mode === "normal");
const classified = classifyWptResults(normalResults, expectations);
const stressResults = results.filter((result) => result.mode === "gc-stress");
const stressPaths = new Set(
	manifest.tests.filter((entry) => entry.gcStress).map((entry) => entry.path),
);
const stressExpectations = expectations.filter((expectation) =>
	stressPaths.has(expectation.path),
);
const stressClassified = classifyWptResults(stressResults, stressExpectations);
const stressUnexpected = stressClassified.results.filter(
	(result) => result.verdict === "UNEXPECTED",
);
const report = {
	schemaVersion: 1,
	revision: manifest.revision,
	results,
	verdicts: classified.results,
	stressVerdicts: stressClassified.results,
	missingExpectations: classified.missing,
	stressMissingExpectations: stressClassified.missing,
};
writeFileSync(resultsPath, `${JSON.stringify(report, null, 2)}\n`);

const unexpected = classified.results.filter((result) => result.verdict === "UNEXPECTED");
console.log(
	`WPT: ${normalResults.length} subtests, ${unexpected.length} unexpected, ${classified.missing.length} stale expectations, ${stressUnexpected.length} GC-stress unexpected, ${stressClassified.missing.length} GC-stress stale expectations`,
);
if (
	unexpected.length > 0 ||
	classified.missing.length > 0 ||
	stressUnexpected.length > 0 ||
	stressClassified.missing.length > 0
) {
	process.exitCode = 1;
}
