import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { resolveBuildConfig } from "../src/build-config.ts";
import {
	createProfileCapture,
	finalizeProfileCapture,
	prepareProfile,
} from "../src/profile-artifact.ts";
import type { PreparedProfile, ProfileManifest } from "../src/profile-artifact.ts";
import { buildNativeBinaryResult } from "../src/test-harness.ts";
import { performanceSourceIdentity } from "./bench-compare.ts";
import { runBoundedProcess } from "./performance-process.ts";
import { assertRuntimeGapParity, parseKernelOutput } from "./runtime-gap.ts";
import type { KernelOutput } from "./runtime-gap.ts";
import { cleanTestEnvironment } from "./test-environment.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURE = path.join(ROOT, "bench/runtime-gap/cases/text-pipeline-phases.mjs");
const VARIANTS = [
	"mixed",
	"early-wide",
	"late-wide",
	"sparse-escapes",
	"dense-escapes",
	"bmp-runs",
	"split-surrogate",
	"joined-surrogate",
];
const PHASES: Readonly<Record<number, string>> = {
	100: "pipeline overhead",
	101: "parse",
	102: "path slice and property lookup",
	103: "construction and replacement",
	104: "JSON quote and serialization",
	105: "full output checksum",
};
const HELP = `Usage: node scripts/profile-text-pipeline.ts [options]

  --variant NAME       Repeatable text control (default: all eight)
  --pairs N            Alternating ordinary/unmarked-profile/marked-profile runs (default: 5)
  --scale N            Runtime-gap scale, 1 through 8 (default: 1)
  --output DIRECTORY   New evidence directory (default: .cache/text-pipeline/<time>)
  --plan=json          Print work without building or writing

Freezes current source, then builds ordinary and sampling production images of
the same complete pipeline. Source edits during the initial copy abort the run.
Every native run must match Node's full UTF-16 checksum and operation count.
Only the measured block receives phase markers; setup and five warmups remain
unphased. Timings are actual nested intervals in the instrumented pipeline.
The report measures sampler and marker overhead separately, preserves residual
pipeline time, and never sums independent workloads into a production attribution.
Short lookup spans include marker dispatch; treat their shares as diagnostic.
Split/joined surrogate controls must produce identical serialized-output checksums.
This profiles the current tree; it is not a baseline/candidate performance test.
Run the environment probe and coordinate CPU use before starting.
`;

function json(file: string, value: unknown): void {
	writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function median(values: Array<number>): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? sorted[middle]!
		: (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function options(args: Array<string>) {
	let pairs = 5;
	let scale = 1;
	let output = path.join(
		ROOT,
		".cache/text-pipeline",
		new Date().toISOString().replaceAll(/[:.]/g, "-"),
	);
	const variants: Array<string> = [];
	for (let index = 0; index < args.length; index++) {
		const option = args[index];
		if (option === "--plan=json") continue;
		const value = args[++index];
		if (value === undefined || value.startsWith("--")) throw new Error(HELP);
		if (option === "--variant" && VARIANTS.includes(value)) variants.push(value);
		else if (option === "--pairs") pairs = Number(value);
		else if (option === "--scale") scale = Number(value);
		else if (option === "--output") output = path.resolve(value);
		else throw new Error(`unknown option or variant: ${option} ${value}`);
	}
	if (!Number.isSafeInteger(pairs) || pairs < 3 || pairs > 20)
		throw new Error("pairs must be 3 through 20");
	if (!Number.isSafeInteger(scale) || scale < 1 || scale > 8)
		throw new Error("scale must be 1 through 8 to bound phase records");
	return {
		pairs,
		scale,
		output,
		variants: [...new Set(variants.length === 0 ? VARIANTS : variants)],
	};
}

async function main() {
	const args = process.argv.slice(2);
	if (args.includes("--help")) {
		console.log(HELP);
		return;
	}
	if (args[0] === "--internal-build") {
		const profile = args[1] === "profile";
		const output = args[2]!;
		const config = resolveBuildConfig({
			engine: { eval: false, realms: false, regexp: false, intl: { enabled: false } },
			surface: { node: true, webPlatform: false, maligator: true },
		});
		const built = buildNativeBinaryResult({
			fixture: FIXTURE,
			name: profile ? "text-pipeline-profile" : "text-pipeline-ordinary",
			entryGoal: "module",
			config,
			compiled: true,
			production: true,
			profileEnabled: profile,
			outDir: output,
			environment: cleanTestEnvironment(),
		});
		const prepared = profile
			? prepareProfile(built.binaryPath, built.programImage)
			: undefined;
		json(path.join(output, "build.json"), {
			binary: built.binaryPath,
			sha256: createHash("sha256").update(readFileSync(built.binaryPath)).digest("hex"),
			toolchain: built.context.toolchain,
			plan: built.context.plan,
			config,
			prepared,
		});
		return;
	}
	const selected = options(args);
	if (args.includes("--plan=json")) {
		console.log(
			JSON.stringify(
				{
					...selected,
					nativeBuilds: 2,
					nodeOracles: selected.variants.length,
					nativeRuns: 3 * selected.pairs * selected.variants.length,
					warmupBlocksPerRun: 5,
					diagnostic: true,
				},
				null,
				2,
			),
		);
		return;
	}
	if (existsSync(selected.output)) throw new Error("output directory must be new");
	mkdirSync(selected.output, { recursive: true });
	console.log(`text pipeline evidence: ${selected.output}`);
	const identity = performanceSourceIdentity(ROOT);
	json(path.join(selected.output, "source.json"), identity);
	const source = path.join(selected.output, "source");
	const files = execFileSync(
		"git",
		["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
		{ cwd: ROOT, encoding: "utf8", timeout: 30_000 },
	);
	for (const file of new Set(files.split("\0").filter(Boolean))) {
		const from = path.join(ROOT, file);
		if (!existsSync(from)) continue;
		const destination = path.join(source, file);
		mkdirSync(path.dirname(destination), { recursive: true });
		cpSync(from, destination, { dereference: false });
	}
	symlinkSync(path.join(ROOT, "node_modules"), path.join(source, "node_modules"), "dir");
	if (performanceSourceIdentity(ROOT).digest !== identity.digest)
		throw new Error("source changed while freezing the profile inputs");
	const frozenFixture = path.join(
		source,
		"bench/runtime-gap/cases/text-pipeline-phases.mjs",
	);
	const environment = cleanTestEnvironment();
	const run = async (
		label: string,
		executable: string,
		arguments_: Array<string>,
		overrides: NodeJS.ProcessEnv = {},
		timeoutMs = 120_000,
	) => {
		const result = await runBoundedProcess(executable, arguments_, {
			environment: { ...environment, ...overrides },
			timeoutMs,
			cwd: ROOT,
		});
		json(path.join(selected.output, `${label}.log.json`), result);
		if (result.exitCode !== 0) throw new Error(`${label} failed: ${result.stderr}`);
		return result.stdout;
	};
	const builds: Record<string, { binary: string; prepared?: PreparedProfile }> = {};
	for (const variant of ["ordinary", "profile"]) {
		const directory = path.join(selected.output, variant);
		mkdirSync(directory);
		console.log(`building ${variant} image`);
		await run(
			`build-${variant}`,
			process.execPath,
			[
				path.join(source, "scripts/profile-text-pipeline.ts"),
				"--internal-build",
				variant,
				directory,
			],
			{},
			600_000,
		);
		builds[variant] = JSON.parse(
			readFileSync(path.join(directory, "build.json"), "utf8"),
		) as (typeof builds)[string];
	}
	const ordinary = builds.ordinary!;
	const profile = builds.profile!;
	const prepared = profile.prepared!;
	type Run = { output: KernelOutput; manifest?: ProfileManifest; capture?: string };
	type Pair = { ordinary: Run; sampled: Run; marked: Run };
	const cases: Array<{
		variant: string;
		oracle: KernelOutput;
		pairs: Array<Pair>;
		summary?: unknown;
	}> = [];
	const save = (complete: boolean) =>
		json(path.join(selected.output, "report.json"), {
			schema: 1,
			complete,
			...selected,
			source: identity,
			phaseNames: PHASES,
			attribution:
				"instrumented complete-pipeline intervals; includes marker dispatch and sampled GC; residual is not redistributed",
			cases,
		});
	for (const variant of selected.variants) {
		const workloadArgs = [String(selected.scale), "5", variant];
		const oracle = parseKernelOutput(
			await run(`${variant}-node`, process.execPath, [frozenFixture, ...workloadArgs]),
		);
		const entry = {
			variant,
			oracle,
			pairs: [] as Array<Pair>,
			summary: undefined as unknown,
		};
		cases.push(entry);
		for (let index = 0; index < selected.pairs; index++) {
			const results: Partial<Pair> = {};
			const order =
				index % 2 === 0
					? (["ordinary", "sampled", "marked"] as const)
					: (["marked", "sampled", "ordinary"] as const);
			for (const mode of order) {
				const label = `${variant}-${index}-${mode}`;
				const capture =
					mode === "ordinary"
						? undefined
						: createProfileCapture(
								label,
								prepared,
								ROOT,
								path.join(selected.output, label),
							);
				const stdout = await run(
					label,
					mode === "ordinary" ? ordinary.binary : profile.binary,
					[...workloadArgs, mode === "marked" ? "phases" : "plain"],
					{ ...capture?.environment, MAL_PROFILE_INTERVAL_US: "1000" },
				);
				const output = parseKernelOutput(stdout);
				assertRuntimeGapParity(oracle, output);
				const manifest =
					capture === undefined
						? undefined
						: finalizeProfileCapture(capture.directory, prepared, label).manifest;
				if (
					manifest !== undefined &&
					(manifest.droppedRecords !== 0 ||
						manifest.droppedFrames !== 0 ||
						manifest.phases.incompleteEvents !== 0)
				)
					throw new Error(`${label}: incomplete profile capture`);
				if (
					mode === "marked" &&
					manifest?.phases.timings.find((phase) => phase.id === 100)?.spans !== 1
				)
					throw new Error(`${label}: measured pipeline phase is missing`);
				results[mode] = { output, manifest, capture: capture?.directory };
			}
			entry.pairs.push(results as Pair);
			save(false);
		}
		entry.summary = {
			ordinaryMedianMs: median(entry.pairs.map((pair) => pair.ordinary.output.elapsedMs)),
			samplingOverheadPercent: median(
				entry.pairs.map(
					(pair) =>
						100 * (pair.sampled.output.elapsedMs / pair.ordinary.output.elapsedMs - 1),
				),
			),
			markerOverheadPercent: median(
				entry.pairs.map(
					(pair) =>
						100 * (pair.marked.output.elapsedMs / pair.sampled.output.elapsedMs - 1),
				),
			),
			instrumentedPhases: Object.entries(PHASES).map(([id, name]) => ({
				id: Number(id),
				name,
				medianSelfMs: median(
					entry.pairs.map(
						(pair) =>
							pair.marked.manifest!.phases.timings.find(
								(phase) => phase.id === Number(id),
							)!.selfMs,
					),
				),
				medianSharePercent: median(
					entry.pairs.map(
						(pair) =>
							(100 *
								pair.marked.manifest!.phases.timings.find(
									(phase) => phase.id === Number(id),
								)!.selfMs) /
							pair.marked.manifest!.phases.measuredWallMs,
					),
				),
			})),
		};
		console.log(JSON.stringify({ variant, ...(entry.summary as object) }));
		save(false);
	}
	const split = cases.find((entry) => entry.variant === "split-surrogate");
	const joined = cases.find((entry) => entry.variant === "joined-surrogate");
	if (split !== undefined && joined !== undefined)
		assertRuntimeGapParity(split.oracle, joined.oracle);
	save(true);
}

await main();
