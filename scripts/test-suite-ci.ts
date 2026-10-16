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

interface PlanStage extends Selection {
	parent?: string;
	files?: Array<string>;
}

interface Shard {
	index: number;
	count: number;
}

interface LaneReport {
	schemaVersion: number;
	runId: string;
	tier: string;
	lane: string;
	shard?: Shard | null;
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

type LaneStage = LaneReport["stages"][number];

function selectionOf(stages: ReadonlyArray<PlanStage>): Array<Selection> {
	return stages.map(({ name, invocation, lane }) => ({ name, invocation, lane }));
}

function assertPassedStages(
	report: LaneReport,
	selection: ReadonlyArray<Selection>,
): void {
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
			stage.invocation !== selection[index]?.invocation
		) {
			throw new Error(`failed, duplicate or unexpected stage: ${stage.name}`);
		}
	}
}

/**
 * A lane contributes either one unsharded report or a complete shard set whose
 * planner-derived test files exactly partition each canonical stage of the lane.
 */
export function combineCheckReports(
	reports: ReadonlyArray<LaneReport>,
	plan: { stages: Array<PlanStage> },
	source: VerificationSource,
	environment: ReturnType<typeof captureVerificationEnvironment>,
	shardPlan: (lane: string, shard: Shard) => Array<PlanStage> = () => {
		throw new Error("sharded reports require the planner's shard selection");
	},
) {
	if (!environment.cc?.version || !environment.rustc?.version) {
		throw new Error("missing verification toolchain identity");
	}
	const completed = new Map<string, LaneStage & { shards?: Array<LaneStage> }>();
	const byLane = new Map<string, Array<LaneReport>>();
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
		byLane.set(report.lane, [...(byLane.get(report.lane) ?? []), report]);
	}
	for (const [lane, laneReports] of byLane) {
		const canonical = plan.stages.filter((stage) => stage.lane === lane);
		const sharded = laneReports.filter((report) => (report.shard ?? null) !== null);
		if (sharded.length === 0) {
			if (laneReports.length !== 1) throw new Error(`duplicate lane: ${lane}`);
			const report = laneReports[0]!;
			assertPassedStages(report, selectionOf(canonical));
			for (const stage of report.stages) completed.set(stage.name, stage);
			continue;
		}
		if (sharded.length !== laneReports.length) {
			throw new Error(`lane mixes sharded and unsharded reports: ${lane}`);
		}
		const count = sharded[0]!.shard!.count;
		const indices = new Set(sharded.map((report) => report.shard!.index));
		if (
			sharded.some((report) => report.shard!.count !== count) ||
			indices.size !== sharded.length
		) {
			throw new Error(`duplicate or inconsistent shard: ${lane}`);
		}
		if (
			sharded.length !== count ||
			[...indices].some((index) => !Number.isInteger(index) || index < 1 || index > count)
		) {
			throw new Error(`incomplete shard set: ${lane}`);
		}
		const files = new Map<string, Array<string>>();
		const parts = new Map<string, Array<LaneStage>>();
		for (const report of sharded) {
			const expected = shardPlan(lane, report.shard!);
			assertPassedStages(report, selectionOf(expected));
			for (const [index, stage] of expected.entries()) {
				const parent = stage.parent ?? stage.name;
				files.set(parent, [...(files.get(parent) ?? []), ...(stage.files ?? [])]);
				parts.set(parent, [...(parts.get(parent) ?? []), report.stages[index]!]);
			}
		}
		for (const parent of parts.keys()) {
			if (!canonical.some((stage) => stage.name === parent)) {
				throw new Error(`failed, duplicate or unexpected stage: ${parent}`);
			}
		}
		for (const stage of canonical) {
			const shardStages = parts.get(stage.name);
			if (shardStages === undefined) continue;
			const expectedFiles = [...(stage.files ?? [])].sort();
			if (
				!isDeepStrictEqual([...(files.get(stage.name) ?? [])].sort(), expectedFiles) ||
				(expectedFiles.length === 0 && shardStages.length !== 1)
			) {
				throw new Error(`shards do not partition ${stage.name}`);
			}
			completed.set(stage.name, {
				name: stage.name,
				invocation: stage.invocation,
				status: 0,
				signal: null,
				shards: shardStages,
			});
		}
	}
	const missing = plan.stages
		.map((stage) => stage.name)
		.filter((name) => !completed.has(name));
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
		selection: selectionOf(plan.stages),
		stages: plan.stages.map((stage) => completed.get(stage.name)!),
		contributingRuns: reports.map(({ lane, runId, shard }) => ({
			lane,
			runId,
			shard: shard ?? null,
		})),
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
	const planFor = (...args: Array<string>) =>
		JSON.parse(
			execFileSync(
				process.execPath,
				["scripts/test-suite.ts", "check", "--workers", "4", ...args, "--plan=json"],
				{ cwd: root, encoding: "utf8" },
			),
		) as { stages: Array<PlanStage> };
	const reports = reportFiles(input).map(
		(file) => JSON.parse(readFileSync(file, "utf8")) as LaneReport,
	);
	const report = combineCheckReports(
		reports,
		planFor(),
		captureVerificationSource(root),
		captureVerificationEnvironment(root),
		(lane, shard) =>
			planFor("--lane", lane, "--shard", `${shard.index}/${shard.count}`).stages,
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
