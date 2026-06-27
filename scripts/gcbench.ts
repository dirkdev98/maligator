/**
 * Generational-GC tuning harness (gc_todo.md task #6/#7).
 *
 * Drives the three workload profiles in bench/gc/ (cli / desktop / server) under a
 * matrix of collector configurations, measuring the metrics each profile cares
 * about:
 *
 *   - wall time      (throughput) — median of N runs
 *   - peak RSS       (footprint)  — /usr/bin/time -l "maximum resident set size"
 *   - GC stats       (pauses)     — parsed from the runtime's MAL_GC_STATS line:
 *       collections, minor/major split, total GC ms, MAX single pause ms
 *
 * A binary is built once per (profile, build-dimension): the generational vs
 * non-generational collector differ at BUILD time (header layout + barrier code),
 * so each gets its own binary; the runtime knobs (MAL_GC_THRESHOLD,
 * MAL_GC_MAJOR_EVERY, MAL_GC_OFF) are env-only and reuse the binary.
 *
 *   node scripts/gcbench.ts [profile ...] [--runs N]
 *
 * Default: all three profiles, 5 runs each. Requires MAL_GC_STATS support in the
 * runtime (prints `[gc-stats] …` to stderr at exit) for the pause columns; without
 * it the wall/RSS columns still populate.
 */

import { spawnSync } from "node:child_process";

interface BuildDim {
	/** Column/group label. */
	label: string;
	/** Build-time env (selects the binary: generational or not). */
	buildEnv: Record<string, string>;
}

interface RunConfig {
	label: string;
	buildDim: string; // which BuildDim binary to use
	/** Runtime-only env (collector knobs). */
	runEnv: Record<string, string>;
}

const BUILD_DIMS: Array<BuildDim> = [
	{ label: "nongen", buildEnv: {} },
	{ label: "gen", buildEnv: { MAL_GC_GENERATIONAL: "1" } },
];

// The configurations swept per profile. Runtime knobs only (binary reused).
const CONFIGS: Array<RunConfig> = [
	{ label: "nongen-default", buildDim: "nongen", runEnv: {} },
	{ label: "nongen-gcoff", buildDim: "nongen", runEnv: { MAL_GC_OFF: "1" } },
	{ label: "gen-default", buildDim: "gen", runEnv: {} },
	{ label: "gen-major2", buildDim: "gen", runEnv: { MAL_GC_MAJOR_EVERY: "2" } },
	{ label: "gen-major4", buildDim: "gen", runEnv: { MAL_GC_MAJOR_EVERY: "4" } },
	{ label: "gen-major16", buildDim: "gen", runEnv: { MAL_GC_MAJOR_EVERY: "16" } },
	{ label: "gen-major64", buildDim: "gen", runEnv: { MAL_GC_MAJOR_EVERY: "64" } },
	{
		label: "gen-thr4m",
		buildDim: "gen",
		runEnv: { MAL_GC_THRESHOLD: String(4 * 1024 * 1024) },
	},
	{
		label: "gen-thr8m",
		buildDim: "gen",
		runEnv: { MAL_GC_THRESHOLD: String(8 * 1024 * 1024) },
	},
	{
		label: "gen-thr64m",
		buildDim: "gen",
		runEnv: { MAL_GC_THRESHOLD: String(64 * 1024 * 1024) },
	},
];

interface GcStats {
	collections: number;
	minor: number;
	major: number;
	totalMs: number;
	maxPauseMs: number;
	peakLiveBytes: number;
}

interface RunResult {
	wallMs: number;
	rssBytes: number;
	stats: GcStats | null;
	output: string;
}

function parseGcStats(stderr: string): GcStats | null {
	const line = stderr.split("\n").find((l) => l.includes("[gc-stats]"));
	if (line === undefined) {
		return null;
	}
	const num = (key: string): number => {
		const m = line.match(new RegExp(`${key}=([0-9.]+)`));
		return m ? Number(m[1]) : 0;
	};
	return {
		collections: num("collections"),
		minor: num("minor"),
		major: num("major"),
		totalMs: num("total_ms"),
		maxPauseMs: num("max_pause_ms"),
		peakLiveBytes: num("peak_live_bytes"),
	};
}

/** Parse macOS `/usr/bin/time -l` peak RSS (bytes). */
function parseMaxRss(timeStderr: string): number {
	const m = timeStderr.match(/([0-9]+)\s+maximum resident set size/);
	return m ? Number(m[1]) : 0;
}

function buildBinary(profile: string, dim: BuildDim): string {
	// The emitted binary name gets buildSuffix() appended (so gen/non-gen don't
	// collide), so parse the actual path from the build's "Binary: …" line rather
	// than reconstruct it.
	const name = `gcbench-${profile}-${dim.label}`;
	const r = spawnSync(
		"node",
		["src/index.ts", `bench/gc/${profile}.js`, "--name", name],
		{
			encoding: "utf8",
			env: { ...process.env, ...dim.buildEnv },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
	const m = out.match(/Binary:\s*(\S+)/);
	if (m === null) {
		throw new Error(`build failed for ${profile}/${dim.label}:\n${out}`);
	}
	return m[1]!;
}

function runOnce(binary: string, runEnv: Record<string, string>): RunResult {
	// `/usr/bin/time -l <binary>` → max RSS on stderr; the binary's own stderr (the
	// gc-stats line) is also on stderr. spawnSync returns stdout AND stderr.
	const env = { ...process.env, ...runEnv, MAL_GC_STATS: "1" };
	const start = process.hrtime.bigint();
	const r = spawnSync("/usr/bin/time", ["-l", binary], {
		env,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const end = process.hrtime.bigint();
	const wallMs = Number(end - start) / 1e6;
	const stderr = r.stderr ?? "";
	return {
		wallMs,
		rssBytes: parseMaxRss(stderr),
		stats: parseGcStats(stderr),
		output: r.stdout ?? "",
	};
}

function median(xs: Array<number>): number {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)]!;
}

const args = process.argv.slice(2);
const runsArg = args.indexOf("--runs");
const runs = runsArg >= 0 ? Number(args[runsArg + 1]) : 5;
const profiles = args.filter((a) => !a.startsWith("--") && !/^\d+$/.test(a));
const PROFILES = profiles.length > 0 ? profiles : ["cli", "desktop", "server"];

for (const profile of PROFILES) {
	console.log(`\n=== profile: ${profile} (median of ${runs}) ===`);
	const binaries = new Map<string, string>();
	for (const dim of BUILD_DIMS) {
		binaries.set(dim.label, buildBinary(profile, dim));
	}
	console.log(
		"config".padEnd(18) +
			"wall(ms)".padStart(10) +
			"rss(MB)".padStart(10) +
			"colls".padStart(8) +
			"minor".padStart(8) +
			"major".padStart(8) +
			"gc(ms)".padStart(10) +
			"maxPause".padStart(10),
	);
	for (const config of CONFIGS) {
		const binary = binaries.get(config.buildDim)!;
		const results: Array<RunResult> = [];
		for (let i = 0; i < runs; i++) {
			results.push(runOnce(binary, config.runEnv));
		}
		const wall = median(results.map((r) => r.wallMs));
		const rss = median(results.map((r) => r.rssBytes)) / (1024 * 1024);
		const last = results[results.length - 1]!;
		const s = last.stats;
		console.log(
			config.label.padEnd(18) +
				wall.toFixed(1).padStart(10) +
				rss.toFixed(1).padStart(10) +
				(s ? String(s.collections) : "-").padStart(8) +
				(s ? String(s.minor) : "-").padStart(8) +
				(s ? String(s.major) : "-").padStart(8) +
				(s ? s.totalMs.toFixed(1) : "-").padStart(10) +
				(s ? s.maxPauseMs.toFixed(2) : "-").padStart(10),
		);
	}
}
