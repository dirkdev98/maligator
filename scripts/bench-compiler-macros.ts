import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cleanTestEnvironment } from "./test-environment.ts";

type Case = "roots" | "accessors" | "optimizer" | "backedges";
type Host = "node" | "native";
interface Sample {
	iterations: number;
	checksum: number | string;
	milliseconds: number;
}
const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const value = (flag: string, fallback: string): string => {
	const index = args.indexOf(flag);
	if (index < 0) return fallback;
	const next = args[index + 1];
	if (!next || next.startsWith("--")) throw new Error(`missing ${flag}`);
	return next;
};
const flags = new Set([
	"--baseline",
	"--seconds",
	"--pairs",
	"--cases",
	"--hosts",
	"--output",
	"--budget-seconds",
]);
for (let index = 0; index < args.length; index++) {
	const flag = args[index]!;
	if (flag === "--help" || flag === "--plan=json") continue;
	if (!flags.has(flag)) throw new Error(`unknown option ${flag}`);
	if (!args[++index] || args[index]!.startsWith("--")) throw new Error(`missing ${flag}`);
}
const baseline = value("--baseline", "HEAD");
const seconds = Number(value("--seconds", "2"));
const pairs = Number(value("--pairs", "3"));
const cases = value("--cases", "roots,backedges,accessors,optimizer").split(
	",",
) as Array<Case>;
const hosts = value("--hosts", "node,native").split(",") as Array<Host>;
const output = path.resolve(
	value("--output", `.cache/bench-compiler-macros/${Date.now()}`),
);
const budgetSeconds = Number(value("--budget-seconds", "600"));
if (args.includes("--help")) {
	console.log(
		"Usage: npm run bench:compiler-macros -- --baseline REF|CHECKOUT [--cases roots,backedges,accessors,optimizer] [--hosts node,native] [--seconds 2] [--pairs 3] [--output DIRECTORY] [--budget-seconds 600] [--plan=json]\n\nRoots replays the 24 largest execution graphs captured from the baseline compiler accessor workload. Accessors traverses real Core storage and opcode registry methods. Optimizer compiles that frozen workload on Node, including construction and target lowering. Native roots/accessors compile only their dependency cones. Calibration chooses fixed iteration counts on the baseline, reused by both revisions. One warmup and alternating pairs follow. Timings exclude process startup and input loading; preparation is included in the wall-clock budget. These slices do not establish full self-compile acceptance.",
	);
	process.exit(0);
}
if (
	!Number.isFinite(seconds) ||
	seconds < 0.1 ||
	seconds > 10 ||
	!Number.isInteger(pairs) ||
	pairs < 1 ||
	pairs > 9 ||
	!Number.isFinite(budgetSeconds) ||
	budgetSeconds < 1 ||
	budgetSeconds > 3600 ||
	cases.some((c) => !["roots", "backedges", "accessors", "optimizer"].includes(c)) ||
	hosts.some((h) => !["node", "native"].includes(h))
)
	throw new Error("invalid macro benchmark selection or budget");
const plan = {
	baseline,
	candidate: root,
	cases,
	hosts,
	seconds,
	pairs,
	budgetSeconds,
	output,
	fullSelfCompile: false,
	baselineUpdate: false,
};
if (args.includes("--plan=json")) {
	console.log(JSON.stringify(plan, null, 2));
	process.exit(0);
}
if (existsSync(output)) throw new Error(`output already exists: ${output}`);
mkdirSync(output, { recursive: true });
const started = Date.now(),
	deadline = started + budgetSeconds * 1000;
const environment = cleanTestEnvironment({ MAL_BUILD_JOBS: "2" });
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
function run(executable: string, arguments_: Array<string>, cwd = root): string {
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw new Error("macro benchmark wall-clock budget exhausted");
	const result = spawnSync(executable, arguments_, {
		cwd,
		env: environment,
		encoding: "utf8",
		timeout: remaining,
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.error || result.status !== 0)
		throw new Error(
			`${executable} ${arguments_.join(" ")} failed: ${result.error ?? result.status}\n${result.stdout}\n${result.stderr}`,
		);
	return result.stdout;
}
function json<T>(stdout: string): T {
	const line = stdout
		.trim()
		.split("\n")
		.findLast((line) => line.startsWith("{"));
	if (!line) throw new Error(`missing result: ${stdout}`);
	return JSON.parse(line) as T;
}
function treeHash(directory: string): string {
	const digest = createHash("sha256");
	const visit = (folder: string) => {
		for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			if (["node_modules", ".git", ".cache"].includes(entry.name)) continue;
			const file = path.join(folder, entry.name);
			if (entry.isDirectory()) visit(file);
			else if (entry.isFile())
				digest.update(path.relative(directory, file)).update(readFileSync(file));
		}
	};
	visit(directory);
	return digest.digest("hex");
}
const scratch = mkdtempSync(path.join(os.tmpdir(), "maligator-compiler-macros-"));
const worker = path.join(root, "scripts/bench-compiler-macro-worker.ts");
const report: Record<string, unknown> = {
	plan,
	node: process.version,
	platform: `${os.platform()} ${os.arch()}`,
	cpus: os.cpus()[0]?.model,
	loadAverage: os.loadavg(),
	started: new Date(started).toISOString(),
	samples: [],
};
try {
	const base = path.join(scratch, "baseline"),
		candidate = path.join(scratch, "candidate");
	mkdirSync(base);
	mkdirSync(candidate);
	if (existsSync(path.resolve(baseline)))
		cpSync(path.resolve(baseline), base, {
			recursive: true,
			filter: (file) => !["node_modules", ".git", ".cache"].includes(path.basename(file)),
		});
	else {
		const archive = path.join(scratch, "baseline.tar");
		run("git", ["archive", "--format=tar", `--output=${archive}`, baseline]);
		run("tar", ["-xf", archive, "-C", base]);
		report.baselineCommit = run("git", ["rev-parse", `${baseline}^{commit}`]).trim();
	}
	const files = run("git", [
		"ls-files",
		"-z",
		"--cached",
		"--others",
		"--exclude-standard",
	])
		.split("\0")
		.filter(Boolean);
	for (const file of files) {
		const input = path.join(root, file);
		if (!existsSync(input)) continue;
		const destination = path.join(candidate, file);
		mkdirSync(path.dirname(destination), { recursive: true });
		copyFileSync(input, destination);
	}
	for (const directory of [base, candidate]) {
		symlinkSync(
			path.join(root, "node_modules"),
			path.join(directory, "node_modules"),
			"dir",
		);
		cpSync(
			path.join(root, "bench/compiler-macros"),
			path.join(directory, "bench/compiler-macros"),
			{ recursive: true },
		);
	}
	report.candidateCommit = run("git", ["rev-parse", "HEAD"]).trim();
	report.candidateDiff = hash(run("git", ["diff", "HEAD"]));
	report.sourceHashes = {
		baseline: treeHash(base),
		candidate: treeHash(candidate),
		fixtures: treeHash(path.join(root, "bench/compiler-macros")),
		worker: hash(readFileSync(worker)),
	};
	if (process.platform === "darwin") report.power = run("pmset", ["-g", "batt"]).trim();
	const input = path.join(base, "bench/compiler-macros/accessors.mts");
	if (cases.includes("roots") || cases.includes("backedges"))
		report.capture = json(
			run(process.execPath, [worker, "capture", base, input, output]),
		);
	const rootsFile = path.join(output, "roots.json");
	if (existsSync(rootsFile)) report.rootsHash = hash(readFileSync(rootsFile));
	const samples: Array<unknown> = [];
	report.samples = samples;
	for (const name of cases)
		for (const host of hosts) {
			if (name === "optimizer" && host === "native") continue;
			const commands: Array<{ executable: string; args: Array<string> }> = [];
			for (const [index, source] of [base, candidate].entries()) {
				const fixture = path.join(source, `bench/compiler-macros/${name}.mts`);
				if (host === "native") {
					console.log(
						`Preparing ${name}/${host}/${index === 0 ? "baseline" : "candidate"}`,
					);
					const buildOutput = path.join(output, `${name}-${index}`);
					const built = json<{ binary: string }>(
						run(process.execPath, [worker, "build", source, fixture, buildOutput]),
					);
					commands.push({ executable: built.binary, args: [] });
				} else if (name === "optimizer")
					commands.push({
						executable: process.execPath,
						args: [worker, "optimizer", source, input, output],
					});
				else commands.push({ executable: process.execPath, args: [fixture] });
			}
			const measure = (revision: number, iterations: number): Sample => {
				const command = commands[revision]!;
				return json(
					run(command.executable, [
						...command.args,
						String(iterations),
						...(name === "roots" || name === "backedges" ? [rootsFile] : []),
					]),
				);
			};
			let iterations = 1;
			let calibration = measure(0, iterations);
			while (calibration.milliseconds < 200) {
				iterations *= 4;
				calibration = measure(0, iterations);
			}
			iterations = Math.max(
				1,
				Math.round((iterations * seconds * 1000) / calibration.milliseconds),
			);
			const warmups = [measure(0, iterations), measure(1, iterations)];
			if (host === "native") {
				const oracle = json<Sample>(
					run(process.execPath, [
						path.join(base, `bench/compiler-macros/${name}.mts`),
						String(iterations),
						...(name === "roots" || name === "backedges" ? [rootsFile] : []),
					]),
				);
				if (oracle.checksum !== warmups[0]!.checksum)
					throw new Error(`${name}/native differs from Node`);
			}
			if (name !== "optimizer" && warmups[0]!.checksum !== warmups[1]!.checksum)
				throw new Error(`${name}/${host} baseline/candidate output mismatch`);
			const timings: [Array<number>, Array<number>] = [[], []];
			for (let pair = 0; pair < pairs; pair++) {
				for (const revision of pair % 2 === 0 ? [0, 1] : [1, 0]) {
					const sample = measure(revision, iterations);
					if (sample.checksum !== warmups[revision]!.checksum)
						throw new Error(`${name}/${host} output mismatch`);
					timings[revision]!.push(sample.milliseconds);
					samples.push({
						name,
						host,
						pair,
						revision: revision === 0 ? "baseline" : "candidate",
						...sample,
					});
				}
			}
			const mean = (values: Array<number>) =>
				values.reduce((sum, n) => sum + n, 0) / values.length;
			const summary = {
				name,
				host,
				iterations,
				outputChanged: warmups[0]!.checksum !== warmups[1]!.checksum,
				baselineMs: mean(timings[0]),
				candidateMs: mean(timings[1]),
				changePercent: (mean(timings[1]) / mean(timings[0]) - 1) * 100,
			};
			console.log(JSON.stringify(summary));
			const summaries = (report.summaries ??= []) as Array<unknown>;
			summaries.push(summary);
			writeFileSync(
				path.join(output, "report.json"),
				`${JSON.stringify(report, null, 2)}\n`,
			);
		}
	report.complete = true;
} catch (error) {
	report.complete = false;
	report.error = String(error);
	throw error;
} finally {
	report.elapsedSeconds = (Date.now() - started) / 1000;
	writeFileSync(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
	rmSync(scratch, { recursive: true, force: true });
	console.log(`Report: ${path.join(output, "report.json")}`);
}
