import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

type Test262Verdict = "FAILED" | "PASSED" | "SKIPPED";

interface CombinedReport {
	schemaVersion: 2;
	backend: "compiled";
	mode: "normal";
	policy: "complete";
	complete: true;
	selectedTests: number;
	summary: Partial<Record<Test262Verdict, number>>;
	regressions: Array<string>;
	improvements: Array<string>;
	baseline: { commit?: string; digest: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown, name: string): Array<string> {
	assert(Array.isArray(value) && value.every((entry) => typeof entry === "string"), name);
	return value;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function parseCombinedReport(value: unknown): CombinedReport {
	assert(isRecord(value), "Test262 report must be an object");
	assert.equal(value.schemaVersion, 2, "Test262 report schema must be 2");
	assert.equal(value.backend, "compiled", "Test262 report must use the compiled backend");
	assert.equal(value.mode, "normal", "Test262 report must use normal mode");
	assert.equal(value.policy, "complete", "Test262 report must use complete policy");
	assert.equal(value.complete, true, "Test262 report must be complete");
	assert(
		typeof value.selectedTests === "number" &&
			Number.isSafeInteger(value.selectedTests) &&
			value.selectedTests > 0,
		"Test262 report must select tests",
	);
	assert(isRecord(value.summary), "Test262 report summary must be an object");
	for (const [verdict, count] of Object.entries(value.summary)) {
		assert(["FAILED", "PASSED", "SKIPPED"].includes(verdict), "unknown verdict");
		assert(
			typeof count === "number" && Number.isSafeInteger(count) && count >= 0,
			"invalid verdict count",
		);
	}
	assert(isRecord(value.baseline), "Test262 report baseline must be an object");
	assert(typeof value.baseline.digest === "string", "Test262 baseline digest is missing");
	assert(
		value.baseline.commit === undefined || typeof value.baseline.commit === "string",
		"Test262 baseline commit is invalid",
	);
	return {
		schemaVersion: 2,
		backend: "compiled",
		mode: "normal",
		policy: "complete",
		complete: true,
		selectedTests: value.selectedTests,
		summary: value.summary,
		regressions: stringArray(value.regressions, "Test262 regressions must be strings"),
		improvements: stringArray(value.improvements, "Test262 improvements must be strings"),
		baseline: {
			...(value.baseline.commit === undefined ? {} : { commit: value.baseline.commit }),
			digest: value.baseline.digest,
		},
	};
}

export function summarizeTest262Report(
	value: unknown,
	runUrl: string,
): { regressions: number; improvements: number; body: string } {
	const report = parseCombinedReport(value);
	const regressionLimit = 200;
	const baseline = report.baseline.commit ?? report.baseline.digest.slice(0, 12);
	const lines = [
		"<!-- maligator-test262-regressions -->",
		"This issue is maintained by the weekly full Test262 workflow.",
		"",
		`Latest run: [GitHub Actions](${runUrl})`,
		`Baseline: \`${escapeHtml(baseline)}\``,
		`Selected: ${report.selectedTests.toLocaleString("en-US")}`,
		`Passed: ${(report.summary.PASSED ?? 0).toLocaleString("en-US")}`,
		`Failed: ${(report.summary.FAILED ?? 0).toLocaleString("en-US")}`,
		`Skipped: ${(report.summary.SKIPPED ?? 0).toLocaleString("en-US")}`,
		`Newly passing: ${report.improvements.length.toLocaleString("en-US")}`,
		"",
	];

	if (report.regressions.length === 0) {
		lines.push("There are no current Test262 regressions.");
	} else {
		lines.push(
			`## Regressions (${report.regressions.length.toLocaleString("en-US")})`,
			"",
		);
		for (const path of report.regressions.slice(0, regressionLimit)) {
			lines.push(`<code>${escapeHtml(path)}</code>`);
		}
		if (report.regressions.length > regressionLimit) {
			lines.push(
				"",
				`The issue shows the first ${regressionLimit}; the workflow artifact contains the complete report.`,
			);
		}
	}

	return {
		regressions: report.regressions.length,
		improvements: report.improvements.length,
		body: `${lines.join("\n")}\n`,
	};
}

function main(): void {
	const [reportPath, bodyPath, runUrl] = process.argv.slice(2);
	if (reportPath === undefined || bodyPath === undefined || runUrl === undefined) {
		throw new Error(
			"usage: node scripts/test262-ci.ts <report.json> <issue.md> <run-url>",
		);
	}
	const summary = summarizeTest262Report(
		JSON.parse(readFileSync(reportPath, "utf8")),
		runUrl,
	);
	writeFileSync(bodyPath, summary.body);
	console.log(
		JSON.stringify({
			regressions: summary.regressions,
			improvements: summary.improvements,
		}),
	);
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main();
}
