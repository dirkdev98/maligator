import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { test262FoldedRegressions } from "../src/test262/policy.ts";
import type { Test262Output } from "../src/test262/types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function test262BaselineFromReport(
	report: unknown,
	corpus: { revision: string; paths: ReadonlySet<string> },
	previous: Test262Output,
	baselineDigest: string,
): Test262Output {
	assert(
		isRecord(report) &&
			report.schemaVersion === 2 &&
			report.backend === "compiled" &&
			report.mode === "normal" &&
			report.policy === "complete" &&
			report.complete === true,
		"baseline import requires a complete compiled/normal combined Test262 report",
	);
	assert(
		previous.sha === corpus.revision &&
			isRecord(report.baseline) &&
			report.baseline.digest === baselineDigest,
		"baseline import must compare against the current HEAD baseline and pinned corpus",
	);
	assert(isRecord(report.results), "baseline report must contain per-test results");
	const entries = Object.entries(report.results);
	assert(
		corpus.paths.size > 0 &&
			report.selectedTests === corpus.paths.size &&
			entries.length === corpus.paths.size &&
			entries.every(([file]) => corpus.paths.has(file)),
		"baseline report must cover every test in the pinned corpus exactly once",
	);
	const results: Test262Output["results"] = {};
	const summary: Test262Output["summary"] = {};
	for (const [file, result] of entries) {
		assert(
			result === "PASSED" || result === "SKIPPED" || result === "FAILED",
			`invalid folded Test262 result for ${file}`,
		);
		results[file] = result;
		summary[result] = (summary[result] ?? 0) + 1;
	}
	assert(isDeepStrictEqual(report.summary, summary), "baseline report totals disagree");
	const regressions = test262FoldedRegressions(
		new Map(Object.entries(results)),
		previous.results,
	);
	assert(
		regressions.length === 0,
		`baseline import has ${regressions.length} unresolved regression(s): ${regressions.slice(0, 10).join(", ")}`,
	);
	assert(isRecord(report.skips), "baseline report must contain skip reasons");
	const skips: Record<string, string> = {};
	for (const [file, reason] of Object.entries(report.skips)) {
		assert(
			results[file] === "SKIPPED" && typeof reason === "string",
			`invalid Test262 skip reason for ${file}`,
		);
		skips[file] = reason;
	}
	assert(
		Object.keys(skips).length === (summary.SKIPPED ?? 0),
		"baseline report is missing skip reasons",
	);
	assert(isRecord(report.code), "baseline report must contain code totals");
	const code = report.code;
	for (const field of ["compiledFiles", "functionCount", "instructionCount"]) {
		assert(
			typeof code[field] === "number" &&
				Number.isSafeInteger(code[field]) &&
				code[field] >= 0,
			`invalid Test262 code total: ${field}`,
		);
	}
	return {
		sha: corpus.revision,
		summary,
		skips,
		code: {
			compiledFiles: code.compiledFiles as number,
			functionCount: code.functionCount as number,
			instructionCount: code.instructionCount as number,
		},
		results,
	};
}
