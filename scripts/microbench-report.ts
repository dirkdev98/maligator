import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

interface ReportContext {
	readonly baseSha: string;
	readonly headSha: string;
	readonly jobStatus: string;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function numeric(value: unknown, digits = 2): string {
	return typeof value === "number" && Number.isFinite(value)
		? value.toFixed(digits)
		: "—";
}

export function isCompleteMicrobenchReport(
	value: unknown,
	context: ReportContext,
): boolean {
	const report = record(value);
	return (
		report.complete === true &&
		report.status === "complete" &&
		report.timingComplete === true &&
		context.jobStatus === "success" &&
		record(report.baseline).commit === context.baseSha &&
		record(report.candidate).commit === context.headSha
	);
}

/** Render only known numeric fields; candidate-generated text is not Markdown. */
export function formatMicrobenchReport(value: unknown, context: ReportContext): string {
	const report = record(value);
	const requestedPairs = record(report.options).pairs;
	const lines = [
		"## Native microbenchmark comparison",
		"",
		`Main: \`${context.baseSha}\``,
		`Candidate: \`${context.headSha}\``,
		"",
	];
	if (value === undefined) {
		lines.push(
			"**No benchmark report was produced.** Check the job logs and evidence artifact for the failed setup, plan, or build.",
		);
		return `${lines.join("\n")}\n`;
	}
	const revisionsMatch =
		record(report.baseline).commit === context.baseSha &&
		record(report.candidate).commit === context.headSha;
	if (!revisionsMatch)
		lines.push(
			"**Revision mismatch: this report does not describe the authorized comparison.**",
			"",
		);
	if (isCompleteMicrobenchReport(value, context))
		lines.push(
			"The requested comparison completed. Completion does not establish a performance improvement.",
			"",
		);
	else
		lines.push(
			"**The comparison failed or is incomplete.** Available measurements below are partial evidence; check logs before drawing conclusions.",
			"",
		);
	if (report.timingComplete === true && report.complete !== true)
		lines.push(
			"All timing pairs finished, but a later step or diagnostic did not complete.",
			"",
		);
	lines.push(
		"Positive reduction means the candidate took less time. MAD is the median absolute deviation of paired reductions, in percentage points.",
		"",
		"| Case | Pairs | Main median (ms) | Candidate median (ms) | Paired reduction | MAD (pp) | Faster pairs |",
		"| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
	);
	const cases = Array.isArray(report.cases) ? report.cases.slice(0, 24) : [];
	for (const value of cases) {
		const entry = record(value);
		const summary = record(entry.summary);
		const id =
			typeof entry.id === "string" && /^[a-z0-9][a-z0-9-]{0,95}$/.test(entry.id)
				? entry.id
				: "invalid-case-id";
		const pairs = `${numeric(summary.pairs ?? 0, 0)}/${numeric(requestedPairs, 0)}${entry.timingComplete === true ? "" : " (partial)"}`;
		lines.push(
			`| ${id} | ${pairs} | ${numeric(summary.baselineMedianMs, 3)} | ${numeric(summary.candidateMedianMs, 3)} | ${numeric(summary.medianReductionPercent)}% | ${numeric(summary.madPercentagePoints)} | ${numeric(summary.fasterPairs, 0)} |`,
		);
	}
	if (cases.length === 0) lines.push("| No measured cases | — | — | — | — | — | — |");
	lines.push(
		"",
		"The artifact preserves the plan, exact revisions, host and toolchain identity, frozen fixtures, raw samples, checksums, generated C, binary sizes, and child logs. Optional diagnostics include final ELF/assembly and any available perf counters. Artifacts expire after seven days.",
		"",
	);
	return lines.join("\n");
}

function main(): void {
	const file = process.argv[2];
	if (!file) throw new Error("Usage: node scripts/microbench-report.ts report.json");
	let report: unknown;
	let parseFailed = false;
	try {
		if (existsSync(file)) {
			if (statSync(file).size > 16 * 1024 * 1024)
				throw new Error("Report exceeds 16 MiB");
			report = JSON.parse(readFileSync(file, "utf8"));
		}
	} catch {
		parseFailed = true;
	}
	const context = {
		baseSha: process.env.BASE_SHA ?? "unknown",
		headSha: process.env.HEAD_SHA ?? "unknown",
		jobStatus: process.env.COMPARISON_JOB_STATUS ?? "unknown",
	};
	const summary = formatMicrobenchReport(report, context);
	const directory = path.resolve(path.dirname(file), "..");
	mkdirSync(directory, { recursive: true });
	writeFileSync(path.join(directory, "summary.md"), summary);
	if (process.env.GITHUB_STEP_SUMMARY)
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
	console.log(summary);
	if (parseFailed) {
		console.error(
			"The benchmark report was unreadable or exceeded 16 MiB; inspect the raw artifact.",
		);
	}
	if (parseFailed || !isCompleteMicrobenchReport(report, context)) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
