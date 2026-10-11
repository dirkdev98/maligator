import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
	captureVerificationEnvironment,
	captureVerificationSource,
} from "./verification-source.ts";
import type { VerificationSource } from "./verification-source.ts";

interface Selection {
	name: string;
	invocation: string;
	lane: string;
}

interface LaneReport {
	schemaVersion: number;
	runId: string;
	tier: string;
	lane: string;
	complete: boolean;
	passed: boolean;
	startedAt: string;
	source: {
		before: VerificationSource;
		after: VerificationSource | null;
		consistent: boolean | null;
	};
	environment: ReturnType<typeof captureVerificationEnvironment>;
	selection: Array<Selection>;
	stages: Array<{
		name: string;
		invocation: string;
		status: number | null;
		signal: string | null;
	}>;
}

export function combineCheckReports(
	reports: ReadonlyArray<LaneReport>,
	plan: { stages: Array<Selection> },
	source: VerificationSource,
	environment: ReturnType<typeof captureVerificationEnvironment>,
) {
	const expected = new Map(plan.stages.map((stage) => [stage.name, stage]));
	const completed = new Map<string, LaneReport["stages"][number]>();
	const lanes = new Set<string>();
	for (const report of reports) {
		if (
			report?.schemaVersion !== 4 ||
			report.tier !== "check" ||
			!report.complete ||
			!report.passed ||
			report.source?.consistent !== true ||
			report.source.after === null
		) {
			throw new Error(`failed or incomplete check report: ${report?.runId ?? "unknown"}`);
		}
		if (
			report.source.before.digest !== source.digest ||
			report.source.after.digest !== source.digest ||
			report.source.before.revision !== source.revision ||
			!isDeepStrictEqual(report.environment, environment)
		) {
			throw new Error(`source or environment mismatch: ${report.runId}`);
		}
		if (lanes.has(report.lane)) throw new Error(`duplicate lane: ${report.lane}`);
		lanes.add(report.lane);
		const selection = plan.stages
			.filter((stage) => stage.lane === report.lane)
			.map(({ name, invocation, lane }) => ({ name, invocation, lane }));
		if (
			selection.length === 0 ||
			!Array.isArray(report.stages) ||
			!isDeepStrictEqual(report.selection, selection) ||
			report.stages.length !== selection.length
		) {
			throw new Error(`selection mismatch: ${report.runId}`);
		}
		for (const [index, stage] of report.stages.entries()) {
			if (
				stage.status !== 0 ||
				stage.signal !== null ||
				stage.name !== selection[index]?.name ||
				stage.invocation !== selection[index]?.invocation ||
				completed.has(stage.name)
			) {
				throw new Error(`failed, duplicate or unexpected stage: ${stage.name}`);
			}
			completed.set(stage.name, stage);
		}
	}
	const missing = [...expected.keys()].filter((name) => !completed.has(name));
	if (missing.length > 0)
		throw new Error(`missing check coverage: ${missing.join(", ")}`);
	return {
		schemaVersion: 4,
		tier: "check",
		complete: true,
		passed: true,
		scope: { coversEntireTier: true, excludedStages: [] },
		source: { before: source, after: source, consistent: true },
		environment,
		selection: plan.stages.map(({ name, invocation, lane }) => ({
			name,
			invocation,
			lane,
		})),
		stages: plan.stages.map((stage) => completed.get(stage.name)!),
		contributingRuns: reports.map(({ lane, runId }) => ({ lane, runId })),
	};
}

function reportFiles(directory: string): Array<string> {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const file = path.join(directory, entry.name);
		return entry.isDirectory()
			? reportFiles(file)
			: entry.name === "report.json"
				? [file]
				: [];
	});
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
	const input = process.argv[2];
	if (input === undefined || process.argv.length !== 3)
		throw new Error("usage: node scripts/test-suite-ci.ts REPORT_DIRECTORY");
	const root = path.resolve(import.meta.dirname, "..");
	const plan = JSON.parse(
		execFileSync(
			process.execPath,
			["scripts/test-suite.ts", "check", "--workers", "4", "--plan=json"],
			{ cwd: root, encoding: "utf8" },
		),
	) as { stages: Array<Selection> };
	const reports = reportFiles(input).map(
		(file) => JSON.parse(readFileSync(file, "utf8")) as LaneReport,
	);
	const report = combineCheckReports(
		reports,
		plan,
		captureVerificationSource(root),
		captureVerificationEnvironment(root),
	);
	const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
	const directory = path.join(root, ".cache/mal-build/test-suite/runs", runId);
	mkdirSync(directory, { recursive: true });
	const file = path.join(directory, "report.json");
	const contents = `${JSON.stringify({ ...report, runId, reportPath: path.relative(root, file) }, null, 2)}\n`;
	writeFileSync(file, contents);
	const latest = path.join(directory, "latest.json");
	writeFileSync(latest, contents);
	renameSync(latest, path.join(root, ".cache/mal-build/test-suite/report-check.json"));
	console.log(`[test-suite] combined check passed; report: ${file}`);
}
