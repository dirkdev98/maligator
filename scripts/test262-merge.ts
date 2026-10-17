import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

type Verdict = "FAILED" | "PASSED" | "SKIPPED";

interface ShardReport {
	baseline: { commit?: string; digest: string };
	shard: { index: number; count: number; selectedTests: number };
	results: Record<string, Verdict>;
	skips: Record<string, string>;
	code: { compiledFiles: number; functionCount: number; instructionCount: number };
	regressions: Array<string>;
	improvements: Array<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function count(value: unknown, name: string): number {
	assert(typeof value === "number" && Number.isSafeInteger(value) && value >= 0, name);
	return value;
}

function strings(value: unknown, name: string): Array<string> {
	assert(Array.isArray(value) && value.every((entry) => typeof entry === "string"), name);
	return value;
}

function parseShardReport(value: unknown): ShardReport {
	assert(
		isRecord(value) &&
			value.schemaVersion === 2 &&
			value.backend === "compiled" &&
			value.mode === "normal" &&
			value.policy === "complete" &&
			value.complete === true,
		"a shard report must be a complete compiled/normal combined Test262 report",
	);
	assert(isRecord(value.shard), "a shard report must name its shard");
	const shard = {
		index: count(value.shard.index, "shard index"),
		count: count(value.shard.count, "shard count"),
		selectedTests: count(value.shard.selectedTests, "shard selection size"),
	};
	assert(isRecord(value.baseline) && typeof value.baseline.digest === "string");
	assert(isRecord(value.results), "a shard report must contain per-test results");
	const results: Record<string, Verdict> = {};
	for (const [file, verdict] of Object.entries(value.results)) {
		assert(
			verdict === "PASSED" || verdict === "FAILED" || verdict === "SKIPPED",
			`invalid folded Test262 result for ${file}`,
		);
		results[file] = verdict;
	}
	assert(count(value.selectedTests, "selected tests") === Object.keys(results).length);
	assert(isRecord(value.skips), "a shard report must contain skip reasons");
	assert(isRecord(value.code), "a shard report must contain code totals");
	return {
		baseline: {
			...(typeof value.baseline.commit === "string"
				? { commit: value.baseline.commit }
				: {}),
			digest: value.baseline.digest,
		},
		shard,
		results,
		skips: Object.fromEntries(
			Object.entries(value.skips).map(([file, reason]) => {
				assert(typeof reason === "string", `invalid skip reason for ${file}`);
				return [file, reason];
			}),
		),
		code: {
			compiledFiles: count(value.code.compiledFiles, "compiled files"),
			functionCount: count(value.code.functionCount, "function count"),
			instructionCount: count(value.code.instructionCount, "instruction count"),
		},
		regressions: strings(value.regressions, "regressions"),
		improvements: strings(value.improvements, "improvements"),
	};
}

/**
 * The combined report of a whole selection from the combined reports of all its
 * shards, which must agree on the baseline and cover the selection exactly once.
 */
export function mergeTest262ShardReports(values: ReadonlyArray<unknown>) {
	const reports = values.map(parseShardReport);
	assert(reports.length > 0, "no Test262 shard reports to merge");
	const [first] = reports;
	const shardCount = first!.shard.count;
	for (const report of reports) {
		assert(
			report.shard.count === shardCount &&
				report.shard.selectedTests === first!.shard.selectedTests,
			"Test262 shard reports describe different selections",
		);
		assert(
			report.baseline.digest === first!.baseline.digest &&
				report.baseline.commit === first!.baseline.commit,
			"Test262 shard reports compare against different baselines",
		);
	}
	const indices = reports.map((report) => report.shard.index).sort((a, b) => a - b);
	assert.deepEqual(
		indices,
		Array.from({ length: shardCount }, (_, index) => index + 1),
		`Test262 needs each of ${shardCount} shards exactly once, found ${indices.join(", ")}`,
	);
	const results: Record<string, Verdict> = {};
	const skips: Record<string, string> = {};
	const summary: Partial<Record<Verdict, number>> = {};
	for (const report of reports) {
		for (const [file, verdict] of Object.entries(report.results)) {
			assert(results[file] === undefined, `Test262 shards overlap at ${file}`);
			results[file] = verdict;
			summary[verdict] = (summary[verdict] ?? 0) + 1;
		}
		Object.assign(skips, report.skips);
	}
	const selectedTests = Object.keys(results).length;
	assert.equal(
		selectedTests,
		first!.shard.selectedTests,
		"Test262 shards do not cover the whole selection",
	);
	return {
		schemaVersion: 2,
		backend: "compiled",
		baseline: first!.baseline,
		mode: "normal",
		policy: "complete",
		complete: true,
		selectedTests,
		summary,
		skips,
		code: {
			compiledFiles: reports.reduce((sum, report) => sum + report.code.compiledFiles, 0),
			functionCount: reports.reduce((sum, report) => sum + report.code.functionCount, 0),
			instructionCount: reports.reduce(
				(sum, report) => sum + report.code.instructionCount,
				0,
			),
		},
		regressions: reports.flatMap((report) => report.regressions).sort(),
		improvements: reports.flatMap((report) => report.improvements).sort(),
		results,
	};
}

function main(): void {
	const [output, ...inputs] = process.argv.slice(2);
	if (output === undefined || inputs.length === 0) {
		throw new Error(
			"usage: node scripts/test262-merge.ts <combined.json> <shard.json>...",
		);
	}
	const merged = mergeTest262ShardReports(
		inputs.map((input) => JSON.parse(readFileSync(input, "utf8")) as unknown),
	);
	writeFileSync(output, `${JSON.stringify(merged, null, 2)}\n`);
	console.log(
		`[test262-merge] ${inputs.length} shards, ${merged.selectedTests} tests, ${merged.regressions.length} regressions, ${merged.improvements.length} improvements: ${output}`,
	);
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main();
}
