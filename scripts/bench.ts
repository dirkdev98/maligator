/**
 * Consolidated benchmark runner + historical tracker. One entry point drives the
 * whole bench/ tree and diffs against a commit-attributed baseline:
 *
 *   node scripts/bench.ts [size|language|gc|http ...] [--runs N] [--update]
 *
 * Benches (default: all):
 *   - size      linked binary + per-archive bytes (the "small binary" goal). No V8 compare.
 *   - language  bench/language.js wall time vs Node/V8 (wide instruction coverage).
 *   - gc        bench/gc/{cli,desktop,server}.js under the generational collector:
 *               wall, peak RSS, max GC pause (macOS: RSS/pauses via /usr/bin/time -l
 *               + MAL_GC_STATS). No V8 compare.
 *   - http      bench/http server: req/s vs Node's http.createServer, driven by `oha`
 *               (multi-threaded, so the load generator isn't the bottleneck). Skipped
 *               if `oha` is not installed.
 *
 * History: bench/baseline.json is a bounded list of entries keyed by commit
 * short-SHA (no timestamps). A run prints current-vs-latest deltas; `--update`
 * records an entry for HEAD (replacing any existing one for that SHA, marking
 * dirty if the tree isn't clean).
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { buildNativeBinary, HOST_MAIN } from "../src/test-harness.ts";

const BASELINE_FILE = "bench/baseline.json";
const HISTORY_LIMIT = 50;

interface SizeMetrics {
	binaryBytes: number;
	runtimeArchiveBytes: number;
	hostArchiveBytes: number;
	engineArchiveBytes: number;
	rustArchiveBytes: number;
}
interface LanguageMetrics {
	malMs: number;
	nodeMs: number;
	ratio: number;
}
interface GcWorkload {
	wallMs: number;
	rssMb: number;
	maxPauseMs: number;
}
interface HttpMetrics {
	malRps: number;
	nodeRps: number;
	ratio: number;
	malP99Ms: number;
	nodeP99Ms: number;
}
interface Entry {
	commit: string;
	dirty: boolean;
	size?: SizeMetrics;
	language?: LanguageMetrics;
	gc?: Record<string, GcWorkload>;
	http?: HttpMetrics | null;
}

function median(xs: Array<number>): number {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)] ?? 0;
}

function fileBytes(pathname: string): number {
	return existsSync(pathname) ? statSync(pathname).size : 0;
}

/** Median wall-clock (ms) of N runs of a binary/command. */
function timeCommand(
	cmd: string,
	args: Array<string>,
	runs: number,
	env?: NodeJS.ProcessEnv,
): number {
	const times: Array<number> = [];
	for (let i = 0; i < runs; i++) {
		const start = process.hrtime.bigint();
		const r = spawnSync(cmd, args, { env: { ...process.env, ...env }, stdio: "ignore" });
		if (r.status !== 0) {
			throw new Error(`command failed: ${cmd} ${args.join(" ")} (status ${r.status})`);
		}
		times.push(Number(process.hrtime.bigint() - start) / 1e6);
	}
	return median(times);
}

// ---- size -----------------------------------------------------------------

function benchSize(): SizeMetrics {
	// Building the language fixture (default test262 main, -O2) also (re)builds the
	// three runtime archives we measure.
	const binary = buildNativeBinary({
		fixture: "bench/language.js",
		name: "bench-language",
	});
	const lib = ".cache/local/lib";
	return {
		binaryBytes: fileBytes(binary),
		runtimeArchiveBytes: fileBytes(`${lib}/libMalRuntime.a`),
		hostArchiveBytes: fileBytes(`${lib}/libMalHost.a`),
		engineArchiveBytes: fileBytes(`${lib}/libLibMaligator.a`),
		rustArchiveBytes: fileBytes(".cache/cargo-target/release/libmal_rust.a"),
	};
}

// ---- language (vs V8) -----------------------------------------------------

function benchLanguage(runs: number): LanguageMetrics {
	const binary = buildNativeBinary({
		fixture: "bench/language.js",
		name: "bench-language",
	});
	const malMs = timeCommand(binary, [], runs);
	const nodeMs = timeCommand("node", ["bench/language.js"], runs);
	return { malMs, nodeMs, ratio: malMs / nodeMs };
}

// ---- gc -------------------------------------------------------------------

function parseGcMaxPause(stderr: string): number {
	const line = stderr.split("\n").find((l) => l.includes("[gc-stats]"));
	const m = line?.match(/max_pause_ms=([0-9.]+)/);
	return m ? Number(m[1]) : 0;
}

/** macOS `/usr/bin/time -l` peak RSS (bytes). */
function parseMaxRss(stderr: string): number {
	const m = stderr.match(/([0-9]+)\s+maximum resident set size/);
	return m ? Number(m[1]) : 0;
}

function benchGc(runs: number): Record<string, GcWorkload> {
	const result: Record<string, GcWorkload> = {};
	const canRss = os.platform() === "darwin";
	// The generational collector differs at BUILD time (header layout + barrier
	// code), so build the gen binary with the collector selected.
	const prev = process.env.MAL_GC_GENERATIONAL;
	process.env.MAL_GC_GENERATIONAL = "1";
	try {
		for (const workload of ["cli", "desktop", "server"]) {
			const binary = buildNativeBinary({
				fixture: `bench/gc/${workload}.js`,
				name: `bench-gc-${workload}`,
			});
			const walls: Array<number> = [];
			const rsss: Array<number> = [];
			let maxPause = 0;
			for (let i = 0; i < runs; i++) {
				const start = process.hrtime.bigint();
				const r = canRss
					? spawnSync("/usr/bin/time", ["-l", binary], {
							env: { ...process.env, MAL_GC_STATS: "1" },
							encoding: "utf-8",
							stdio: ["ignore", "ignore", "pipe"],
						})
					: spawnSync(binary, [], {
							env: { ...process.env, MAL_GC_STATS: "1" },
							encoding: "utf-8",
							stdio: ["ignore", "ignore", "pipe"],
						});
				walls.push(Number(process.hrtime.bigint() - start) / 1e6);
				const stderr = r.stderr ?? "";
				rsss.push(parseMaxRss(stderr));
				maxPause = Math.max(maxPause, parseGcMaxPause(stderr));
			}
			result[workload] = {
				wallMs: median(walls),
				rssMb: median(rsss) / (1024 * 1024),
				maxPauseMs: maxPause,
			};
		}
	} finally {
		if (prev === undefined) delete process.env.MAL_GC_GENERATIONAL;
		else process.env.MAL_GC_GENERATIONAL = prev;
	}
	return result;
}

// ---- http (vs Node) -------------------------------------------------------

function ohaAvailable(): boolean {
	return spawnSync("oha", ["--version"], { stdio: "ignore" }).status === 0;
}

/** Wait until `url` responds, or throw after ~5s. */
function waitReachable(url: string): void {
	for (let i = 0; i < 100; i++) {
		const r = spawnSync("curl", ["-s", "-o", "/dev/null", url]);
		if (r.status === 0) return;
		execFileSync("sleep", ["0.05"]);
	}
	throw new Error(`server never came up: ${url}`);
}

/** Run oha for `duration` at `conc`, returning req/s + p99 ms. */
function ohaRun(
	url: string,
	duration: string,
	conc: number,
): { rps: number; p99Ms: number } {
	const out = execFileSync(
		"oha",
		["-z", duration, "-c", String(conc), "--no-tui", "--output-format", "json", url],
		{ encoding: "utf-8" },
	);
	const j = JSON.parse(out) as {
		summary: { requestsPerSec: number };
		latencyPercentiles?: Record<string, number>;
	};
	return {
		rps: j.summary.requestsPerSec,
		p99Ms: (j.latencyPercentiles?.p99 ?? 0) * 1000,
	};
}

function benchHttp(duration: string, conc: number): HttpMetrics | null {
	if (!ohaAvailable()) {
		console.log("http: `oha` not installed — skipping (install oha for the http bench).");
		return null;
	}
	const malBin = buildNativeBinary({
		fixture: "bench/http/server_mal.js",
		name: "bench-http-mal",
		mainFile: HOST_MAIN,
	});
	const mal = spawn(malBin, [], { stdio: "ignore" });
	const node = spawn("node", ["bench/http/server_node.js"], { stdio: "ignore" });
	try {
		waitReachable("http://127.0.0.1:3111/");
		waitReachable("http://127.0.0.1:3112/");
		// Warm up both before measuring.
		ohaRun("http://127.0.0.1:3111/", "3s", 50);
		ohaRun("http://127.0.0.1:3112/", "3s", 50);
		const malRes = ohaRun("http://127.0.0.1:3111/", duration, conc);
		const nodeRes = ohaRun("http://127.0.0.1:3112/", duration, conc);
		return {
			malRps: malRes.rps,
			nodeRps: nodeRes.rps,
			ratio: malRes.rps / nodeRes.rps,
			malP99Ms: malRes.p99Ms,
			nodeP99Ms: nodeRes.p99Ms,
		};
	} finally {
		mal.kill("SIGKILL");
		node.kill("SIGKILL");
	}
}

// ---- history + reporting --------------------------------------------------

function gitInfo(): { commit: string; dirty: boolean } {
	const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
		encoding: "utf-8",
	}).trim();
	const dirty =
		execFileSync("git", ["status", "--porcelain"], { encoding: "utf-8" }).trim().length >
		0;
	return { commit, dirty };
}

function loadBaseline(): { entries: Array<Entry> } {
	if (!existsSync(BASELINE_FILE)) return { entries: [] };
	return JSON.parse(readFileSync(BASELINE_FILE, "utf-8")) as { entries: Array<Entry> };
}

function kb(bytes: number): string {
	return `${(bytes / 1024).toFixed(1)}KB`;
}

function delta(
	current: number,
	previous: number | undefined,
	lowerIsBetter = true,
): string {
	if (previous === undefined || previous === 0) return "";
	const pct = ((current - previous) / previous) * 100;
	const sign = pct >= 0 ? "+" : "";
	const better = lowerIsBetter ? pct < 0 : pct > 0;
	const mark = Math.abs(pct) < 0.5 ? "  " : better ? " ↓" : " ↑";
	return ` (${sign}${pct.toFixed(1)}% vs ${previous.toFixed(0)}${mark})`;
}

function report(entry: Entry, previous: Entry | undefined): void {
	console.log(`\n=== bench @ ${entry.commit}${entry.dirty ? " (dirty)" : ""} ===`);
	if (entry.size) {
		const p = previous?.size;
		console.log("size:");
		console.log(
			`  binary   ${kb(entry.size.binaryBytes)}${delta(entry.size.binaryBytes, p?.binaryBytes)}`,
		);
		console.log(
			`  runtime  ${kb(entry.size.runtimeArchiveBytes)}${delta(entry.size.runtimeArchiveBytes, p?.runtimeArchiveBytes)}`,
		);
		console.log(
			`  host     ${kb(entry.size.hostArchiveBytes)}${delta(entry.size.hostArchiveBytes, p?.hostArchiveBytes)}`,
		);
		console.log(
			`  engine   ${kb(entry.size.engineArchiveBytes)}${delta(entry.size.engineArchiveBytes, p?.engineArchiveBytes)}`,
		);
		console.log(
			`  rust     ${kb(entry.size.rustArchiveBytes)}${delta(entry.size.rustArchiveBytes, p?.rustArchiveBytes)}`,
		);
	}
	if (entry.language) {
		const p = previous?.language;
		console.log("language (vs V8):");
		console.log(
			`  maligator ${entry.language.malMs.toFixed(1)}ms${delta(entry.language.malMs, p?.malMs)}`,
		);
		console.log(`  node      ${entry.language.nodeMs.toFixed(1)}ms`);
		console.log(
			`  ratio     ${entry.language.ratio.toFixed(2)}x${delta(entry.language.ratio, p?.ratio)}`,
		);
	}
	if (entry.gc) {
		console.log("gc (generational):");
		for (const [name, w] of Object.entries(entry.gc)) {
			const p = previous?.gc?.[name];
			console.log(
				`  ${name.padEnd(8)} wall ${w.wallMs.toFixed(1)}ms${delta(w.wallMs, p?.wallMs)}  rss ${w.rssMb.toFixed(1)}MB  maxPause ${w.maxPauseMs.toFixed(2)}ms`,
			);
		}
	}
	if (entry.http) {
		const p = previous?.http ?? undefined;
		console.log("http (vs Node):");
		console.log(
			`  maligator ${entry.http.malRps.toFixed(0)} req/s (p99 ${entry.http.malP99Ms.toFixed(2)}ms)${delta(entry.http.malRps, p?.malRps, false)}`,
		);
		console.log(
			`  node      ${entry.http.nodeRps.toFixed(0)} req/s (p99 ${entry.http.nodeP99Ms.toFixed(2)}ms)`,
		);
		console.log(
			`  ratio     ${entry.http.ratio.toFixed(2)}x${delta(entry.http.ratio, p?.ratio, false)}`,
		);
	}
}

// ---- main -----------------------------------------------------------------

const args = process.argv.slice(2);
const update = args.includes("--update");
const runsIdx = args.indexOf("--runs");
const runs = runsIdx >= 0 ? Number(args[runsIdx + 1]) : 5;
const selected = args.filter((a) => !a.startsWith("--") && !/^\d+$/.test(a));
const which = selected.length > 0 ? selected : ["size", "language", "gc", "http"];

const { commit, dirty } = gitInfo();
const entry: Entry = { commit, dirty };

if (which.includes("size")) entry.size = benchSize();
if (which.includes("language")) entry.language = benchLanguage(runs);
if (which.includes("gc")) entry.gc = benchGc(runs);
if (which.includes("http")) entry.http = benchHttp("10s", 50);

const baseline = loadBaseline();
const previous = baseline.entries[baseline.entries.length - 1];
report(entry, previous);

if (update) {
	const last = baseline.entries[baseline.entries.length - 1];
	if (last && last.commit === commit) {
		baseline.entries[baseline.entries.length - 1] = entry;
	} else {
		baseline.entries.push(entry);
	}
	if (baseline.entries.length > HISTORY_LIMIT) {
		baseline.entries = baseline.entries.slice(-HISTORY_LIMIT);
	}
	writeFileSync(BASELINE_FILE, `${JSON.stringify(baseline, null, 2)}\n`);
	console.log(`\nUpdated ${BASELINE_FILE} for ${commit}.`);
} else {
	console.log("\n(run with --update to record this as the new baseline entry)");
}
