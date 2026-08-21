import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CommandProgress } from "../src/command-progress.ts";
import { HOST_MODULES } from "../src/compiler/frontend/host-modules.ts";

const TEST262_FILE = "scripts/test262.json";
const BENCH_FILE = "bench/baseline.json";
const SITE_FILE = "website/index.html";
const COMPATIBILITY_FILE = "website/compatibility.html";
const WPT_FILE = "tests/wpt/curated.json";
const WPT_EXPECTATIONS_FILE = "tests/wpt/expectations.json";
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
	world: "closed";
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
	lowerSemanticMs: number;
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
		world: point.world,
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

function replaceRegion(
	source: string,
	name: string,
	body: string,
	file = SITE_FILE,
): string {
	const start = `<!-- ${name}:start -->`;
	const end = `<!-- ${name}:end -->`;
	const startIndex = source.indexOf(start);
	const endIndex = source.indexOf(end);
	if (startIndex < 0 || endIndex < startIndex) {
		throw new Error(`${file} is missing the ${name} generated region`);
	}
	return `${source.slice(0, startIndex)}${start}\n${body}\n${end}${source.slice(endIndex + end.length)}`;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

const SHAPE_ONLY_NODE_MODULES = new Set([
	"node:cluster",
	"node:dns",
	"node:domain",
	"node:http2",
	"node:https",
	"node:inspector",
	"node:readline",
	"node:worker_threads",
]);

const SHAPE_ONLY_NODE_APIS = new Set([
	"node:child_process#exec",
	"node:child_process#execFile",
	"node:child_process#spawn",
	"node:crypto#X509Certificate",
	"node:crypto#createSign",
	"node:crypto#createVerify",
	"node:crypto#generateKeyPairSync",
	"node:crypto#publicEncrypt",
	"node:perf_hooks#monitorEventLoopDelay",
	"node:stream#pipeline",
	"node:url#urlToHttpOptions",
	"node:zlib#createGzip",
	"node:zlib#deflate",
]);

function nodeCompatibilityHtml(): string {
	return [...HOST_MODULES.values()]
		.sort((a, b) => a.id.localeCompare(b.id))
		.map((module) => {
			const rows = module.named
				.map((name) => {
					const id = `${module.id}#${name}`;
					const shapeOnly =
						SHAPE_ONLY_NODE_MODULES.has(module.id) || SHAPE_ONLY_NODE_APIS.has(id);
					return `<tr>
	<td><code class="api-name">${escapeHtml(id)}</code></td>
	<td><span class="status ${shapeOnly ? "stub" : "partial"}">${shapeOnly ? "Shape-only stub" : "Partial implementation"}</span></td>
</tr>`;
				})
				.join("\n");
			return `<section class="inventory-group module-group" aria-labelledby="${escapeHtml(module.id)}">
	<div class="inventory-heading">
		<h3 id="${escapeHtml(module.id)}"><code>${escapeHtml(module.id)}</code></h3>
		<span>${module.named.length} recognized ${module.named.length === 1 ? "API" : "APIs"}${module.hasDefault ? " · default export" : ""}</span>
	</div>
	<div class="table-wrap">
		<table>
			<thead><tr><th>API</th><th>Status</th></tr></thead>
			<tbody>${rows}</tbody>
		</table>
	</div>
</section>`;
		})
		.join("\n");
}

interface WptManifest {
	revision: string;
	tests: Array<{ path: string }>;
}

interface WptExpectations {
	expectations: Array<unknown>;
}

interface WptApi {
	name: string;
	tests: Array<string>;
}

interface WptDomain {
	id: string;
	name: string;
	apis: Array<WptApi>;
}

const WPT_DOMAINS: Array<WptDomain> = [
	{
		id: "dom",
		name: "DOM events and aborts",
		apis: [
			{ name: "AbortSignal#any", tests: ["dom/abort/AbortSignal.any.js"] },
			{ name: "AbortSignal#timeout", tests: ["dom/abort/timeout.any.js"] },
			{ name: "AbortSignal#event", tests: ["dom/abort/event.any.js"] },
			{
				name: "EventTarget#addEventListener",
				tests: ["dom/events/AddEventListenerOptions-once.any.js"],
			},
			{
				name: "Event#constructor",
				tests: ["dom/events/Event-constructors.any.js"],
			},
			{ name: "Event#isTrusted", tests: ["dom/events/Event-isTrusted.any.js"] },
		],
	},
	{
		id: "encoding",
		name: "Encoding",
		apis: [
			{
				name: "TextDecoder#decode",
				tests: [
					"encoding/api-basics.any.js",
					"encoding/api-surrogates-utf8.any.js",
					"encoding/textdecoder-arguments.any.js",
					"encoding/textdecoder-byte-order-marks.any.js",
					"encoding/textdecoder-fatal.any.js",
					"encoding/textdecoder-fatal-streaming.any.js",
					"encoding/textdecoder-ignorebom.any.js",
				],
			},
			{
				name: "TextEncoder#encode",
				tests: ["encoding/textencoder-utf16-surrogates.any.js"],
			},
		],
	},
	{
		id: "fetch",
		name: "Fetch primitives",
		apis: [
			{
				name: "Headers#constructor",
				tests: [
					"fetch/api/headers/header-setcookie.any.js",
					"fetch/api/headers/headers-basic.any.js",
					"fetch/api/headers/headers-casing.any.js",
					"fetch/api/headers/headers-combine.any.js",
					"fetch/api/headers/headers-errors.any.js",
					"fetch/api/headers/headers-normalize.any.js",
					"fetch/api/headers/headers-structure.any.js",
				],
			},
			{
				name: "Request#constructor",
				tests: [
					"fetch/api/request/forbidden-method.any.js",
					"fetch/api/request/request-constructor-init-body-override.any.js",
					"fetch/api/request/request-error.any.js",
					"fetch/api/request/request-init-002.any.js",
					"fetch/api/request/request-init-stream.any.js",
					"fetch/api/request/request-headers.any.js",
					"fetch/api/request/request-structure.any.js",
				],
			},
			{
				name: "Request#clone",
				tests: ["fetch/api/request/request-clone-readable-stream-body.any.js"],
			},
			{
				name: "Request#arrayBuffer",
				tests: ["fetch/api/request/request-consume-empty.any.js"],
			},
			{
				name: "Response#constructor",
				tests: [
					"fetch/api/response/response-from-stream.any.js",
					"fetch/api/response/response-init-001.any.js",
					"fetch/api/response/response-init-002.any.js",
					"fetch/api/response/response-init-contenttype.any.js",
					"fetch/api/response/response-stream-bad-chunk.any.js",
				],
			},
			{
				name: "Response#arrayBuffer",
				tests: [
					"fetch/api/response/response-consume-empty.any.js",
					"fetch/api/response/response-consume-stream.any.js",
				],
			},
			{
				name: "Response#error",
				tests: [
					"fetch/api/response/response-error.any.js",
					"fetch/api/response/response-error-from-stream.any.js",
					"fetch/api/response/response-static-error.any.js",
				],
			},
			{
				name: "Response#json",
				tests: ["fetch/api/response/response-static-json.any.js"],
			},
			{
				name: "Response#redirect",
				tests: ["fetch/api/response/response-static-redirect.any.js"],
			},
		],
	},
	{
		id: "timers",
		name: "Timers",
		apis: [
			{
				name: "setTimeout",
				tests: ["html/webappapis/timers/negative-settimeout.any.js"],
			},
			{
				name: "clearTimeout",
				tests: ["html/webappapis/timers/cleartimeout-clearinterval.any.js"],
			},
			{
				name: "setInterval",
				tests: [
					"html/webappapis/timers/missing-timeout-setinterval.any.js",
					"html/webappapis/timers/negative-setinterval.any.js",
				],
			},
			{
				name: "clearInterval",
				tests: ["html/webappapis/timers/clearinterval-from-callback.any.js"],
			},
		],
	},
	{
		id: "streams",
		name: "Streams",
		apis: [
			{
				name: "ReadableStream#constructor",
				tests: [
					"streams/readable-streams/bad-strategies.any.js",
					"streams/readable-streams/bad-underlying-sources.any.js",
					"streams/readable-streams/constructor.any.js",
					"streams/readable-streams/count-queuing-strategy-integration.any.js",
					"streams/readable-streams/floating-point-total-queue-size.any.js",
					"streams/readable-streams/general.any.js",
					"streams/readable-streams/patched-global.any.js",
					"streams/readable-streams/reentrant-strategies.any.js",
					"streams/readable-streams/templated.any.js",
				],
			},
			{
				name: "ReadableStream byte sources",
				tests: [
					"streams/readable-byte-streams/general.any.js",
					"streams/readable-byte-streams/patched-global.any.js",
					"streams/readable-byte-streams/templated.any.js",
				],
			},
			{
				name: "ReadableStreamBYOBReader#read",
				tests: [
					"streams/readable-byte-streams/bad-buffers-and-views.any.js",
					"streams/readable-byte-streams/read-min.any.js",
				],
			},
			{
				name: "ReadableByteStreamController#byobRequest",
				tests: ["streams/readable-byte-streams/construct-byob-request.any.js"],
			},
			{
				name: "ReadableByteStreamController#enqueue",
				tests: ["streams/readable-byte-streams/enqueue-with-detached-buffer.any.js"],
			},
			{
				name: "ReadableStreamBYOBRequest#respond",
				tests: ["streams/readable-byte-streams/respond-after-enqueue.any.js"],
			},
			{
				name: "ReadableStream#pipeTo",
				tests: [
					"streams/piping/abort.any.js",
					"streams/piping/general-addition.any.js",
					"streams/piping/close-propagation-backward.any.js",
					"streams/piping/close-propagation-forward.any.js",
					"streams/piping/flow-control.any.js",
					"streams/piping/general.any.js",
				],
			},
			{
				name: "ReadableStream#pipeThrough",
				tests: ["streams/piping/pipe-through.any.js"],
			},
			{
				name: "ReadableStream#cancel",
				tests: ["streams/readable-streams/cancel.any.js"],
			},
			{
				name: "ReadableStream#getReader",
				tests: ["streams/readable-streams/default-reader.any.js"],
			},
			{
				name: "ReadableStream#tee",
				tests: [
					"streams/readable-byte-streams/tee.any.js",
					"streams/readable-streams/tee.any.js",
				],
			},
			{
				name: "ReadableStream#values / @@asyncIterator",
				tests: ["streams/readable-streams/async-iterator.any.js"],
			},
			{
				name: "ReadableStream.from",
				tests: ["streams/readable-streams/from.any.js"],
			},
			{
				name: "WritableStream#constructor",
				tests: [
					"streams/writable-streams/bad-strategies.any.js",
					"streams/writable-streams/bad-underlying-sinks.any.js",
					"streams/writable-streams/byte-length-queuing-strategy.any.js",
					"streams/writable-streams/count-queuing-strategy.any.js",
					"streams/writable-streams/floating-point-total-queue-size.any.js",
					"streams/writable-streams/constructor.any.js",
					"streams/writable-streams/properties.any.js",
					"streams/writable-streams/reentrant-strategy.any.js",
					"streams/writable-streams/start.any.js",
				],
			},
			{
				name: "WritableStream#error",
				tests: ["streams/writable-streams/error.any.js"],
			},
			{
				name: "WritableStream#writer",
				tests: ["streams/writable-streams/general.any.js"],
			},
			{
				name: "CountQueuingStrategy#constructor",
				tests: ["streams/queuing-strategies.any.js"],
			},
		],
	},
	{
		id: "url",
		name: "URL",
		apis: [
			{ name: "URL#searchParams", tests: ["url/url-searchparams.any.js"] },
			{ name: "URL#canParse", tests: ["url/url-statics-canparse.any.js"] },
			{ name: "URL#parse", tests: ["url/url-statics-parse.any.js"] },
			{ name: "URL#toJSON", tests: ["url/url-tojson.any.js"] },
			{
				name: "URLSearchParams#constructor",
				tests: ["url/urlencoded-parser.any.js", "url/urlsearchparams-constructor.any.js"],
			},
			{ name: "URLSearchParams#append", tests: ["url/urlsearchparams-append.any.js"] },
			{ name: "URLSearchParams#delete", tests: ["url/urlsearchparams-delete.any.js"] },
			{ name: "URLSearchParams#forEach", tests: ["url/urlsearchparams-foreach.any.js"] },
			{ name: "URLSearchParams#get", tests: ["url/urlsearchparams-get.any.js"] },
			{ name: "URLSearchParams#getAll", tests: ["url/urlsearchparams-getall.any.js"] },
			{ name: "URLSearchParams#has", tests: ["url/urlsearchparams-has.any.js"] },
			{ name: "URLSearchParams#set", tests: ["url/urlsearchparams-set.any.js"] },
			{ name: "URLSearchParams#size", tests: ["url/urlsearchparams-size.any.js"] },
			{ name: "URLSearchParams#sort", tests: ["url/urlsearchparams-sort.any.js"] },
			{
				name: "URLSearchParams#toString",
				tests: ["url/urlsearchparams-stringifier.any.js"],
			},
		],
	},
	{
		id: "hr-time",
		name: "High Resolution Time",
		apis: [
			{ name: "performance#now", tests: ["hr-time/monotonic-clock.any.js"] },
			{ name: "performance#timeOrigin", tests: ["hr-time/basic.any.js"] },
		],
	},
];

function wptCompatibilityHtml(manifest: WptManifest): string {
	const manifestPaths = new Set(manifest.tests.map((test) => test.path));
	const catalogPaths = WPT_DOMAINS.flatMap((domain) => domain.apis).flatMap(
		(api) => api.tests,
	);
	const missing = catalogPaths.filter((pathname) => !manifestPaths.has(pathname));
	const uncatalogued = [...manifestPaths].filter(
		(pathname) => !catalogPaths.includes(pathname),
	);
	if (missing.length > 0 || uncatalogued.length > 0) {
		throw new Error(
			`compatibility WPT catalog drift: missing=${missing.join(",")} uncatalogued=${uncatalogued.join(",")}`,
		);
	}
	return WPT_DOMAINS.map(
		(domain) => `<section class="inventory-group" aria-labelledby="wpt-${domain.id}">
	<div class="inventory-heading">
		<h3 id="wpt-${domain.id}">${escapeHtml(domain.name)}</h3>
		<span>${domain.apis.length} API ${domain.apis.length === 1 ? "slice" : "slices"}</span>
	</div>
	<div class="table-wrap">
		<table>
			<thead><tr><th>API</th><th>Status</th></tr></thead>
			<tbody>
${domain.apis
	.map(
		(api) => `				<tr>
					<td><code class="api-name">${escapeHtml(api.name)}</code></td>
					<td><span class="status partial">Partial implementation</span></td>
				</tr>`,
	)
	.join("\n")}
			</tbody>
		</table>
	</div>
</section>`,
	).join("\n");
}

function updateCompatibility(mascot: string): void {
	const manifest = JSON.parse(readFileSync(WPT_FILE, "utf8")) as WptManifest;
	const expectations = JSON.parse(
		readFileSync(WPT_EXPECTATIONS_FILE, "utf8"),
	) as WptExpectations;
	let html = readFileSync(COMPATIBILITY_FILE, "utf8");
	html = replaceRegion(
		html,
		"nav-mascot",
		`<img class="nav-mascot" src="data:image/webp;base64,${mascot}" alt="" width="768" height="768">`,
		COMPATIBILITY_FILE,
	);
	html = replaceRegion(
		html,
		"compatibility-summary",
		`<strong>${manifest.tests.length}</strong><span>fully passing WPT files</span>
<strong>${HOST_MODULES.size}</strong><span>recognized Node.js modules</span>
<strong>${expectations.expectations.length}</strong><span>suppressed WPT failures</span>`,
		COMPATIBILITY_FILE,
	);
	html = replaceRegion(
		html,
		"node-compatibility",
		nodeCompatibilityHtml(),
		COMPATIBILITY_FILE,
	);
	html = replaceRegion(
		html,
		"wpt-compatibility",
		wptCompatibilityHtml(manifest),
		COMPATIBILITY_FILE,
	);
	html = replaceRegion(
		html,
		"wpt-revision",
		`<code>${escapeHtml(manifest.revision)}</code>`,
		COMPATIBILITY_FILE,
	);
	writeFileSync(COMPATIBILITY_FILE, html);
	formatSiteFiles([COMPATIBILITY_FILE]);
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
		"nav-mascot",
		`<img class="nav-mascot" src="data:image/webp;base64,${mascot}" alt="" width="768" height="768">`,
	);
	html = replaceRegion(
		html,
		"mascot",
		`<img class="mascot" src="data:image/webp;base64,${mascot}" alt="A focused Belgian Malinois with a mischievous expression" width="768" height="768">`,
	);
	writeFileSync(SITE_FILE, html);
	formatSiteFiles([SITE_FILE]);
	updateCompatibility(mascot);
}

const isMain =
	process.argv[1] !== undefined &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	const progress = new CommandProgress("site-update");
	progress.stage(1, 1, "update site history and compatibility data");
	updateSite();
	progress.stagePassed(1, 1, "update site history and compatibility data");
	progress.complete();
}
