import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	readdirSync,
	rmSync,
	statfsSync,
	statSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import type { MaligatorLibraryContract } from "../src/public-api.d.ts";
import { runBoundedProcess } from "./performance-process.ts";
import { cleanTestEnvironment } from "./test-environment.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(ROOT, "bench/ffi");
const FLAGS = ["-O2", "-g0", "-flto=thin", "-fno-omit-frame-pointer", "-std=c2x"];
const LANES = ["c", "bun", "maligator"] as const;
type Lane = (typeof LANES)[number];
interface Case {
	mode: string;
	size: number;
	pattern: string;
	iterations: number;
}
interface Output extends Case {
	checksum: number;
	digest: string;
	elapsedMs: number;
	identity: string;
}
interface FileIdentity {
	path: string;
	bytes: number;
	sha256: string;
}
interface Identity {
	source: ReturnType<typeof source>;
	inputs: Record<string, string>;
	libraries: Record<string, FileIdentity>;
	binaries: Record<string, FileIdentity>;
	compiler: string;
	os: string;
	node: string;
	bun: string;
	linkage: Record<string, { imports: string; libraries: string }>;
}
interface Sample {
	lane: Lane;
	round: number;
	stage: string;
	output: Output;
	wallMs: number;
	cpuMs: number;
	cpuPercent: number;
	peakRssBytes: number;
	freeBytes: number;
}

const { values } = parseArgs({
	options: {
		phase: { type: "string", default: "build" },
		output: { type: "string" },
		"sqlite-prefix": { type: "string" },
		"zstd-prefix": { type: "string" },
		"crypto-prefix": { type: "string" },
		bun: { type: "string", default: "bun" },
		case: { type: "string", multiple: true },
		runs: { type: "string", default: "5" },
		"budget-seconds": { type: "string", default: "285" },
		plan: { type: "string" },
		help: { type: "boolean" },
	},
});
if (values.help) {
	console.log(`Usage: node scripts/bench-ffi.ts --phase build|measure --output DIRECTORY [options]

  --sqlite-prefix PATH      installed SQLite prefix with include/ and lib/
  --zstd-prefix PATH        installed zstd prefix (default: pkg-config libzstd)
  --crypto-prefix PATH      installed OpenSSL prefix (default: pkg-config openssl)
  --case MODE               repeat to select modes; see --plan=json
  --runs N                  interleaved rounds, 1..15 (default: 5)
  --budget-seconds N        phase budget including preparation (default: 285)
  --bun PATH                Bun executable (default: bun on PATH)
  --plan=json               inspect the selection without writing or building

Build creates frozen inputs and production C/Maligator executables. Measure uses
that directory, verifies identities, calibrates C to 150ms once per case, then
freezes equal iteration counts across all three callers. Warmup is bounded by
10,000 calls and 16 MiB. Timings exclude setup, warmup and validation; CPU/RSS
cover the complete child. One round is indicative. No saved baseline is updated.
SQLite uses one shared adapter to isolate embedded SQLite symbols. Timed adapter
exports forward one call each. zstd and EVP updates call the libraries directly.
Bun uses exact BigInt u64 arguments/results and Buffer views, without ptr caching.
libc-strcmp compares owned ASCII strings with early, equal and late differences.
Bun encodes terminated Buffer inputs before timing; Maligator converts JS strings.
`);
	process.exit(0);
}
const phase = values.phase;
if (phase !== "build" && phase !== "measure") throw new Error("Invalid --phase");
const rounds = Number(values.runs),
	budgetSeconds = Number(values["budget-seconds"]);
if (
	!Number.isInteger(rounds) ||
	rounds < 1 ||
	rounds > 15 ||
	!Number.isFinite(budgetSeconds) ||
	budgetSeconds <= 0
)
	throw new Error("Invalid measurement limits");
const CASES: Array<Case> = [
	{ mode: "sqlite-bind", size: 0, pattern: "repeat", iterations: 1000000 },
	{ mode: "sqlite-row", size: 0, pattern: "repeat", iterations: 250000 },
	...[64, 4095, 65535].flatMap((size) =>
		["early", "equal", "late"].map((pattern) => ({
			mode: "libc-strcmp",
			size,
			pattern,
			iterations: size === 64 ? 1000000 : size === 4095 ? 250000 : 10000,
		})),
	),
	...[64, 1024, 1048576].flatMap((size) =>
		["repeat", "random"].flatMap((pattern) =>
			["zstd-compress", "zstd-decompress"].map((mode) => ({
				mode,
				size,
				pattern,
				iterations: size === 1048576 ? 256 : 65536,
			})),
		),
	),
	...[16, 1024, 1048576].map((size) => ({
		mode: "crypto-update",
		size,
		pattern: "random",
		iterations: size === 16 ? 1000000 : size === 1024 ? 262144 : 512,
	})),
].filter((c) => values.case === undefined || values.case.includes(c.mode));
if (
	CASES.length === 0 ||
	values.case?.some((mode) => !CASES.some((c) => c.mode === mode))
)
	throw new Error("Unknown case mode");
const output = path.resolve(values.output ?? `.cache/bench-ffi/${Date.now()}`);
const plan = {
	phase,
	output,
	cases: CASES,
	rounds,
	budgetSeconds,
	callerFlags: FLAGS,
	lanes: LANES,
	calibrationTargetMs: 150,
	childTimeoutMs: 60000,
	resourceScope: "whole process including setup, warmup and validation",
	timingScope: "ordinary warmed loop",
	sizeT: "exact BigInt in both JS callers",
	sqlitePrefix: values["sqlite-prefix"],
	zstdPrefix: values["zstd-prefix"],
	cryptoPrefix: values["crypto-prefix"],
};
if (values.plan !== undefined) {
	if (values.plan !== "json") throw new Error("Use --plan=json");
	console.log(JSON.stringify(plan, null, 2));
	process.exit(0);
}
if (process.platform !== "darwin")
	throw new Error("This runner currently requires macOS shared-library tooling");
const deadline = performance.now() + budgetSeconds * 1000;
const environment = cleanTestEnvironment();
delete environment.BUN_OPTIONS;
delete environment.BUN_JIT;
function text(command: string, args: Array<string>): string {
	const result = spawnSync(command, args, {
		cwd: ROOT,
		env: environment,
		encoding: "utf8",
		timeout: 30000,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command}: ${result.stderr}`);
	return result.stdout.trim();
}
function sha(file: string): string {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}
function fileIdentity(file: string): FileIdentity {
	const resolved = realpathSync(file);
	return { path: resolved, bytes: statSync(resolved).size, sha256: sha(resolved) };
}
function source() {
	return {
		commit: text("git", ["rev-parse", "HEAD"]),
		status: text("git", ["status", "--porcelain"]),
		diffSha256: createHash("sha256")
			.update(text("git", ["diff", "HEAD", "--", "."]))
			.digest("hex"),
		files: Object.fromEntries<string>([
			[path.relative(ROOT, import.meta.filename), sha(import.meta.filename)] as const,
			...readdirSync(FIXTURES).map(
				(name) =>
					[
						path.relative(ROOT, path.join(FIXTURES, name)),
						sha(path.join(FIXTURES, name)),
					] as const,
			),
		]),
	};
}
function save(name: string, value: unknown): void {
	writeFileSync(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`);
}
function freeBytes(): number {
	const fs = statfsSync(output);
	return fs.bavail * fs.bsize;
}
async function execute(
	label: string,
	executable: string,
	args: Array<string>,
	cwd = ROOT,
	timed = false,
) {
	const remaining = deadline - performance.now();
	if (remaining <= 0) throw new Error("Phase budget exhausted");
	const start = performance.now();
	const result = await runBoundedProcess(
		timed ? "/usr/bin/time" : executable,
		timed ? ["-lp", executable, ...args] : args,
		{ environment, cwd, timeoutMs: Math.min(remaining, timed ? 60000 : 285000) },
	);
	const wallMs = performance.now() - start;
	writeFileSync(path.join(output, `${label}.stdout.log`), result.stdout);
	writeFileSync(path.join(output, `${label}.stderr.log`), result.stderr);
	if (result.exitCode !== 0)
		throw new Error(`${label} failed; see ${output}/${label}.stderr.log`);
	return { ...result, wallMs };
}

async function build(): Promise<void> {
	if (existsSync(output)) throw new Error("Build needs a new output directory");
	mkdirSync(path.join(output, "inputs"), { recursive: true });
	mkdirSync(path.join(output, "native"));
	save("plan.json", plan);
	const before = source();
	const prefixes = {
		sqlite:
			values["sqlite-prefix"] ?? text("pkg-config", ["--variable=prefix", "sqlite3"]),
		zstd: values["zstd-prefix"] ?? text("pkg-config", ["--variable=prefix", "libzstd"]),
		crypto:
			values["crypto-prefix"] ?? text("pkg-config", ["--variable=prefix", "openssl"]),
	};
	const libraries = Object.fromEntries(
		Object.entries(prefixes).map(([name, prefix]) => [
			name,
			fileIdentity(
				path.join(prefix, "lib", `lib${name === "sqlite" ? "sqlite3" : name}.dylib`),
			),
		]),
	);
	for (const file of readdirSync(FIXTURES))
		copyFileSync(path.join(FIXTURES, file), path.join(output, "inputs", file));
	const inputs = path.join(output, "inputs"),
		native = path.join(output, "native");
	const includes = Object.values(prefixes).map((prefix) => path.join(prefix, "include"));
	const adapter = path.join(native, "libffi-bench.dylib");
	await execute("adapter-build", "/usr/bin/clang", [
		...FLAGS,
		"-dynamiclib",
		"-fPIC",
		...includes.map((p) => `-I${p}`),
		path.join(inputs, "sqlite.c"),
		path.join(inputs, "text.c"),
		...Object.values(libraries).map((l) => l.path),
		"-Wl,-twolevel_namespace",
		"-install_name",
		adapter,
		"-o",
		adapter,
	]);
	await execute("control-build", "/usr/bin/clang", [
		...FLAGS,
		...includes.map((p) => `-I${p}`),
		path.join(inputs, "control.c"),
		adapter,
		...Object.values(libraries).map((l) => l.path),
		"-lc++",
		"-o",
		path.join(native, "control"),
	]);
	await execute("control-strip", "/usr/bin/strip", ["-x", path.join(native, "control")]);
	const contracts: Record<string, MaligatorLibraryContract> = {
		text: {
			headers: ["text.h"],
			find: [{ includeDirs: [inputs], libraryDirs: [native], libraries: ["ffi-bench"] }],
		},
		sqlite: {
			headers: ["sqlite.h"],
			find: [{ includeDirs: [inputs], libraryDirs: [native], libraries: ["ffi-bench"] }],
			types: {
				FfiBenchDb: {
					handle: { destroy: { function: "ffi_bench_sql_close", success: "0" } },
				},
				FfiBenchStatement: { handle: { destroy: "ffi_bench_sql_finalize" } },
			},
		},
		zstd: {
			headers: ["zstd.h"],
			find: [
				{
					includeDirs: [path.join(prefixes.zstd, "include")],
					libraryDirs: [path.join(prefixes.zstd, "lib")],
					libraries: ["zstd"],
				},
			],
			types: {
				ZSTD_CCtx: { handle: { destroy: "ZSTD_freeCCtx" } },
				ZSTD_DCtx: { handle: { destroy: "ZSTD_freeDCtx" } },
			},
			functions: {
				ZSTD_compressCCtx: {
					params: {
						dst: { bytes: { length: "dstCapacity" } },
						src: { bytes: { length: "srcSize" } },
					},
				},
				ZSTD_decompressDCtx: {
					params: {
						dst: { bytes: { length: "dstCapacity" } },
						src: { bytes: { length: "srcSize" } },
					},
				},
			},
		},
		crypto: {
			headers: ["crypto.h", "openssl/evp.h"],
			find: [
				{
					includeDirs: [inputs, path.join(prefixes.crypto, "include")],
					libraryDirs: [native, path.join(prefixes.crypto, "lib")],
					libraries: ["ffi-bench", "crypto"],
				},
			],
			types: {
				EVP_MD_CTX: { handle: { destroy: "EVP_MD_CTX_free" } },
				EVP_MD: { handle: {} },
			},
			functions: {
				EVP_sha256: { returns: { borrowed: true } },
				EVP_DigestInit_ex: { params: { impl: { constant: "0" } } },
				EVP_DigestUpdate: { params: { d: { bytes: { length: "cnt" } } } },
				ffi_bench_crypto_final: { params: { output: { bytes: { length: "capacity" } } } },
			},
		},
	};
	for (const [name, contract] of Object.entries(contracts))
		writeFileSync(
			path.join(inputs, `${name}.ffi.ts`),
			`export default ${JSON.stringify(contract, null, 2)};\n`,
		);
	writeFileSync(
		path.join(inputs, "maligator.build.ts"),
		`export default ${JSON.stringify({ entry: "maligator.mjs", surface: { node: true, webPlatform: true }, ffi: Object.fromEntries(Object.keys(contracts).map((name) => [name, { contract: `${name}.ffi.ts`, link: "shared" }])) }, null, 2)};\n`,
	);
	const result = await execute(
		"maligator-build",
		process.execPath,
		[path.join(ROOT, "src/index.ts"), "build", "--production", "--verbose"],
		inputs,
	);
	const binary = result.stdout.trim().split("\n").at(-1);
	if (!binary || !existsSync(binary))
		throw new Error("Build omitted its executable path");
	copyFileSync(binary, path.join(native, "maligator"));
	rmSync(path.join(inputs, ".cache"), { recursive: true, force: true });
	if (!isDeepStrictEqual(source(), before))
		throw new Error("Source changed while building");
	const bun = text("/usr/bin/which", [values.bun]);
	const linkage = Object.fromEntries(
		["control", "maligator"].map((name) => {
			const binary = path.join(native, name);
			const imports = text("/usr/bin/nm", ["-m", "-u", binary]);
			for (const [symbol, provider] of [
				["EVP_DigestUpdate", "libcrypto"],
				["ZSTD_compressCCtx", "libzstd"],
				["ZSTD_decompressDCtx", "libzstd"],
				["ffi_bench_sql_bind", "libffi-bench"],
				["ffi_bench_string_compare", "libffi-bench"],
			])
				if (!imports.includes(`external _${symbol} (from ${provider})`))
					throw new Error(`${name}: unexpected provider for ${symbol}`);
			const linkedLibraries = text("/usr/bin/otool", ["-L", binary]);
			for (const library of Object.values(libraries)) {
				const matched = linkedLibraries
					.split("\n")
					.slice(1)
					.map((line) => line.trim().split(" (compatibility")[0]!)
					.some((p) => existsSync(p) && realpathSync(p) === library.path);
				if (!matched && (name === "control" || library.path !== libraries.sqlite!.path))
					throw new Error(`${name}: missing ${library.path}`);
			}
			return [name, { imports, libraries: linkedLibraries }];
		}),
	);
	const identity: Identity = {
		source: before,
		inputs: Object.fromEntries(
			readdirSync(inputs).map((name) => [name, sha(path.join(inputs, name))]),
		),
		libraries,
		binaries: Object.fromEntries(
			[
				["control", path.join(native, "control")],
				["maligator", path.join(native, "maligator")],
				["adapter", adapter],
				["bun", bun],
				["node", process.execPath],
			].map(([name, file]) => [name!, fileIdentity(file!)]),
		),
		compiler: text("/usr/bin/clang", ["--version"]),
		os: text("/usr/bin/sw_vers", []),
		node: text(process.execPath, ["--version"]),
		bun: text(bun, ["--version"]),
		linkage,
	};
	save("identity.json", identity);
	console.log(path.join(output, "identity.json"));
}

async function measure(): Promise<void> {
	const identity = JSON.parse(
		readFileSync(path.join(output, "identity.json"), "utf8"),
	) as Identity;
	if (existsSync(path.join(output, "samples.jsonl")))
		throw new Error("Samples already exist; use a fresh measurement directory");
	const before = source();
	if (!isDeepStrictEqual(before, identity.source))
		throw new Error("Source changed after build");
	const verifyFiles = () => {
		for (const file of [
			...Object.values(identity.libraries),
			...Object.values(identity.binaries),
		])
			if (sha(file.path) !== file.sha256) throw new Error(`Changed binary: ${file.path}`);
		for (const [name, digest] of Object.entries(identity.inputs))
			if (sha(path.join(output, "inputs", name)) !== digest)
				throw new Error(`Changed input: ${name}`);
	};
	verifyFiles();
	const samples: Array<Sample> = [];
	const powerBefore = text("pmset", ["-g", "batt"]);
	save("measurement-plan.json", plan);
	let sequence = 0;
	const run = async (
		lane: Lane,
		c: Case,
		stage: string,
		round: number,
	): Promise<Sample> => {
		const args = [c.mode, String(c.size), String(c.iterations), c.pattern];
		const command =
			lane === "bun"
				? identity.binaries.bun!.path
				: identity.binaries[lane === "c" ? "control" : "maligator"]!.path;
		if (lane === "bun") args.unshift(path.join(output, "inputs/bun.mjs"));
		if (lane === "bun")
			args.push(identity.libraries.zstd!.path, identity.libraries.crypto!.path);
		const free = freeBytes();
		const result = await execute(
			`sample-${sequence++}-${lane}`,
			command,
			args,
			path.join(output, "inputs"),
			true,
		);
		const data = JSON.parse(result.stdout) as Output;
		if (
			!isDeepStrictEqual(
				{
					mode: data.mode,
					size: data.size,
					iterations: data.iterations,
					pattern: data.pattern,
				},
				c,
			) ||
			!Number.isFinite(data.elapsedMs) ||
			(stage === "smoke" ? data.elapsedMs < 0 : data.elapsedMs <= 0) ||
			!Number.isInteger(data.checksum) ||
			typeof data.digest !== "string"
		)
			throw new Error("Invalid workload output");
		const rss = result.stderr.match(/^\s*(\d+)\s+maximum resident set size\s*$/m)?.[1];
		const user = result.stderr.match(/^user\s+([\d.]+)/m)?.[1];
		const sys = result.stderr.match(/^sys\s+([\d.]+)/m)?.[1];
		if (rss === undefined || user === undefined || sys === undefined)
			throw new Error("Missing resource counters");
		const cpuMs = (Number(user) + Number(sys)) * 1000;
		const sample = {
			lane,
			stage,
			round,
			output: data,
			wallMs: result.wallMs,
			cpuMs,
			cpuPercent: (cpuMs / result.wallMs) * 100,
			peakRssBytes: Number(rss),
			freeBytes: Math.min(free, freeBytes()),
		};
		samples.push(sample);
		appendFileSync(path.join(output, "samples.jsonl"), `${JSON.stringify(sample)}\n`);
		return sample;
	};
	const parity = (rows: Array<Sample>) => {
		const first = rows[0]!.output;
		for (const { output: row } of rows)
			if (
				row.checksum !== first.checksum ||
				row.digest !== first.digest ||
				row.identity !== first.identity
			)
				throw new Error("C/Bun/Maligator output or library identity mismatch");
		const parts = first.identity.trim().split("\n");
		const expected = [
			...Array<string>(8).fill(identity.libraries.sqlite!.path),
			...Array<string>(2).fill(identity.libraries.zstd!.path),
			...Array<string>(3).fill(identity.libraries.crypto!.path),
		];
		if (
			!isDeepStrictEqual(
				parts.slice(4, 4 + expected.length).map((p) => realpathSync(p)),
				expected,
			)
		)
			throw new Error("Calls resolved to unexpected library builds");
		// System libraries can live only in the dyld shared cache, without a disk file to hash.
		if (parts.length !== expected.length + 5 || !parts.at(-1)?.startsWith("/usr/lib/"))
			throw new Error("strcmp did not resolve to the shared system library");
	};
	const calibrated: Array<Case> = [];
	for (const c of CASES) {
		const smoke = [];
		for (const lane of LANES)
			smoke.push(await run(lane, { ...c, iterations: 31 }, "smoke", -1));
		parity(smoke);
		const probe = await run("c", c, "calibration", -1);
		calibrated.push({
			...c,
			iterations: Math.max(
				1,
				Math.min(100000000, Math.round((c.iterations * 150) / probe.output.elapsedMs)),
			),
		});
	}
	save("calibrated-cases.json", calibrated);
	for (let round = 0; round < rounds; round++) {
		for (const [index, c] of (round % 2
			? [...calibrated].reverse()
			: calibrated
		).entries()) {
			const offset = (round + index) % LANES.length;
			const order = [...LANES.slice(offset), ...LANES.slice(0, offset)];
			if (round % 2) order.reverse();
			const rows = [];
			for (const lane of order) rows.push(await run(lane, c, "measure", round));
			parity(rows);
			console.log(
				JSON.stringify({
					round,
					case: c,
					nsPerIteration: Object.fromEntries(
						rows.map((r) => [r.lane, (r.output.elapsedMs * 1e6) / c.iterations]),
					),
				}),
			);
		}
	}
	verifyFiles();
	if (!isDeepStrictEqual(source(), before))
		throw new Error("Source changed during measurement");
	const powerAfter = text("pmset", ["-g", "batt"]);
	if (powerBefore.includes("Battery Power") !== powerAfter.includes("Battery Power"))
		throw new Error("Power source changed");
	const median = (numbers: Array<number>) =>
		[...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)]!;
	save("report.json", {
		complete: true,
		utc: new Date().toISOString(),
		identity,
		plan,
		cases: calibrated,
		powerBefore,
		powerAfter,
		minimumFreeBytes: Math.min(...samples.map((r) => r.freeBytes)),
		summary: calibrated.flatMap((c) =>
			LANES.map((lane) => {
				const selected = samples.filter(
					(r) =>
						r.stage === "measure" &&
						r.lane === lane &&
						r.output.mode === c.mode &&
						r.output.size === c.size &&
						r.output.pattern === c.pattern,
				);
				return {
					...c,
					lane,
					nsPerIterationMedian: median(
						selected.map((r) => (r.output.elapsedMs * 1e6) / c.iterations),
					),
					peakRssBytesMedian: median(selected.map((r) => r.peakRssBytes)),
					cpuMsMedian: median(selected.map((r) => r.cpuMs)),
					cpuPercentMedian: median(selected.map((r) => r.cpuPercent)),
				};
			}),
		),
		samples,
	});
	console.log(path.join(output, "report.json"));
}

try {
	if (phase === "build") await build();
	else await measure();
} catch (error) {
	if (existsSync(output))
		save("failure.json", {
			complete: false,
			utc: new Date().toISOString(),
			error: String(error),
		});
	throw error;
}
