import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const TEST262_FILE = "scripts/test262.json";
const BENCH_FILE = "bench/baseline.json";
const SITE_FILE = "website/index.html";
const MASCOT_FILE = "website/mascot.webp";
const SITE_META_FILE = "website/site-meta.json";
const FORMATTER = path.resolve("node_modules/.bin/oxfmt");
export const TEST262_HISTORY_START = "2026-06-07T00:00:00Z";

interface DatedPoint {
	date: string;
}

interface Test262File {
	sha: string;
	summary: Record<string, number>;
}

export interface Test262Point extends DatedPoint {
	commit: string;
	corpus: string;
	passed: number;
	failed: number;
	skipped: number;
	percent: number;
}

export interface SelfCompileMetrics {
	maligatorMs: number;
	nodeMs: number;
	maligatorPhases: SelfCompilePhases;
	nodePhases: SelfCompilePhases;
	runs: number;
	units: number;
	maligatorCodeUnits: number;
	nodeCodeUnits: number;
	platform: string;
	arch: string;
	nodeVersion: string;
}

interface SelfCompilePhases {
	graphMs: number;
	semanticMs: number;
	compileToIrMs: number;
	optimizeMs: number;
	regallocMs: number;
	lowerMs: number;
	emitMs: number;
	writeMs: number;
}

export interface SelfCompilePoint extends DatedPoint, SelfCompileMetrics {
	commit: string;
	preview?: boolean;
}

function selfCompileMetrics(point: SelfCompilePoint): SelfCompileMetrics {
	return {
		maligatorMs: point.maligatorMs,
		nodeMs: point.nodeMs,
		maligatorPhases: point.maligatorPhases,
		nodePhases: point.nodePhases,
		runs: point.runs,
		units: point.units,
		maligatorCodeUnits: point.maligatorCodeUnits,
		nodeCodeUnits: point.nodeCodeUnits,
		platform: point.platform,
		arch: point.arch,
		nodeVersion: point.nodeVersion,
	};
}

interface BenchmarkFile {
	selfCompile?: SelfCompileMetrics;
}

interface SiteMeta {
	binaryBytes: number | null;
	binaryPlatform: string;
	binaryProfile: string;
}

interface GitRevision<T> {
	commit: string;
	date: string;
	value: T;
}

export function summarizeTest262(
	summary: Readonly<Record<string, number>>,
): Pick<Test262Point, "passed" | "failed" | "skipped" | "percent"> {
	const passed = summary.PASSED ?? 0;
	const skipped = summary.SKIPPED ?? 0;
	const failed = Object.entries(summary).reduce(
		(total, [status, count]) =>
			status === "PASSED" || status === "SKIPPED" ? total : total + count,
		0,
	);
	const total = passed + failed + skipped;
	return {
		passed,
		failed,
		skipped,
		percent: total === 0 ? 0 : (passed / total) * 100,
	};
}

export function isoWeekKey(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) throw new Error(`invalid history date '${value}'`);
	const day = date.getUTCDay() || 7;
	date.setUTCDate(date.getUTCDate() + 4 - day);
	const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
	const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
	return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function latestPerWeek<T extends DatedPoint>(points: ReadonlyArray<T>): Array<T> {
	const result = new Map<string, T>();
	for (const point of [...points].sort((a, b) => a.date.localeCompare(b.date))) {
		result.set(isoWeekKey(point.date), point);
	}
	return [...result.values()];
}

/** Keep the first point and every later point whose measured value changed. */
export function changesOnly<T>(
	points: ReadonlyArray<T>,
	valueOf: (point: T) => unknown,
): Array<T> {
	const result: Array<T> = [];
	let previous: string | undefined;
	let hasPrevious = false;
	for (const point of points) {
		const current = JSON.stringify(valueOf(point));
		if (!hasPrevious || current !== previous) result.push(point);
		previous = current;
		hasPrevious = true;
	}
	return result;
}

export function since<T extends DatedPoint>(
	points: ReadonlyArray<T>,
	start: string,
): Array<T> {
	const startTime = new Date(start).getTime();
	if (Number.isNaN(startTime)) throw new Error(`invalid history start '${start}'`);
	return points.filter((point) => new Date(point.date).getTime() >= startTime);
}

function git(args: Array<string>, maxBuffer = 64 * 1024 * 1024): string {
	return execFileSync("git", args, {
		encoding: "utf8",
		maxBuffer,
		stdio: ["ignore", "pipe", "ignore"],
	});
}

function history<T>(file: string): Array<GitRevision<T>> {
	const log = git(["log", "--follow", "--format=%H%x09%cI", "--", file]).trim();
	if (log === "") return [];
	const revisions: Array<GitRevision<T>> = [];
	for (const row of log.split("\n")) {
		const [commit, date] = row.split("\t");
		if (commit === undefined || date === undefined) continue;
		try {
			revisions.push({
				commit,
				date,
				value: JSON.parse(git(["show", `${commit}:${file}`])) as T,
			});
		} catch {
			// --follow can include the pre-rename boundary where this exact path is absent.
		}
	}
	return revisions.reverse();
}

export function test262History(): Array<Test262Point> {
	return latestPerWeek(
		since(
			history<Test262File>(TEST262_FILE).map(({ commit, date, value }) => ({
				commit: commit.slice(0, 8),
				date,
				corpus: value.sha.slice(0, 8),
				...summarizeTest262(value.summary),
			})),
			TEST262_HISTORY_START,
		),
	);
}

function currentCommit(): string {
	return git(["rev-parse", "--short=8", "HEAD"]).trim();
}

export function selfCompileHistory(
	previewDate = statSync(BENCH_FILE).mtime,
): Array<SelfCompilePoint> {
	const committed: Array<SelfCompilePoint> = changesOnly(
		history<BenchmarkFile>(BENCH_FILE)
			.filter(
				(
					revision,
				): revision is GitRevision<BenchmarkFile & { selfCompile: SelfCompileMetrics }> =>
					revision.value.selfCompile !== undefined,
			)
			.map(({ commit, date, value }) => ({
				commit: commit.slice(0, 8),
				date,
				...value.selfCompile,
			})),
		selfCompileMetrics,
	);
	const current = (JSON.parse(readFileSync(BENCH_FILE, "utf8")) as BenchmarkFile)
		.selfCompile;
	if (current !== undefined) {
		const latest = committed.at(-1);
		const comparable = latest === undefined ? undefined : selfCompileMetrics(latest);
		if (JSON.stringify(comparable) !== JSON.stringify(current)) {
			committed.push({
				commit: currentCommit(),
				date: previewDate.toISOString(),
				preview: true,
				...current,
			});
		}
	}
	return committed;
}

function replaceRegion(source: string, name: string, body: string): string {
	const start = `<!-- ${name}:start -->`;
	const end = `<!-- ${name}:end -->`;
	const startIndex = source.indexOf(start);
	const endIndex = source.indexOf(end);
	if (startIndex < 0 || endIndex < startIndex) {
		throw new Error(`${SITE_FILE} is missing the ${name} generated region`);
	}
	return `${source.slice(0, startIndex)}${start}\n${body}\n${end}${source.slice(endIndex + end.length)}`;
}

function jsonScript(value: unknown): string {
	return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function formatSiteFiles(files: Array<string>): void {
	execFileSync(FORMATTER, files, { stdio: "ignore" });
}

export function updateSite(): void {
	const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
		version: string;
	};
	const meta = JSON.parse(readFileSync(SITE_META_FILE, "utf8")) as SiteMeta;
	const test262 = test262History();
	const selfCompile = selfCompileHistory();
	const data = {
		version: packageJson.version,
		test262,
		selfCompile,
		binary: meta,
	};
	let html = readFileSync(SITE_FILE, "utf8");
	html = replaceRegion(
		html,
		"site-data",
		`<script id="site-data" type="application/json">${jsonScript(data)}</script>`,
	);
	const mascot = readFileSync(MASCOT_FILE).toString("base64");
	html = replaceRegion(
		html,
		"mascot",
		`<img class="mascot" src="data:image/webp;base64,${mascot}" alt="A focused Belgian Malinois with a mischievous expression" width="768" height="768">`,
	);
	writeFileSync(SITE_FILE, html);
	formatSiteFiles([SITE_FILE]);
}

const isMain =
	process.argv[1] !== undefined &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) updateSite();
