import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveBuildConfig } from "../src/build-config.ts";
import { ccExtraFlags } from "../src/build-flags.ts";
import type {
	NativeBuildPhaseEvent,
	NativeBuildCommandResourceEvent,
} from "../src/native-build-context.ts";
import { buildNativeBinaryResult, HOST_MAIN } from "../src/test-harness.ts";
import { toolArguments } from "../src/toolchain.ts";

interface Sample {
	name: string;
	ms: number;
	checksum: number;
}
const label = process.argv[2] ?? "candidate";
const baseline = process.argv[3];
const outDir = path.resolve(".cache/rest-forwarding", label);
mkdirSync(outDir, { recursive: true });
const phases: Array<NativeBuildPhaseEvent> = [];
const resources: Array<NativeBuildCommandResourceEvent> = [];
const config = resolveBuildConfig({ engine: { primordials: "mutable" } });
const buildStarted = performance.now();
const result = buildNativeBinaryResult({
	fixture: "bench/rest-forwarding.mjs",
	name: "forwarding",
	outDir,
	mainFile: HOST_MAIN,
	config,
	production: true,
	onNativeBuildPhase: (event) => phases.push(event),
	measureNativeBuildResources: true,
	onNativeCommandResource: (event) => resources.push(event),
});
const buildMs = performance.now() - buildStarted;
const run = (command: string, args: Array<string>): Array<Sample> => {
	const output = spawnSync(command, args, { encoding: "utf8", timeout: 120000 });
	if (output.status !== 0) throw new Error(output.stderr || String(output.error));
	return output.stdout
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Sample);
};
const reference = run(process.execPath, ["bench/rest-forwarding.mjs"]);
const check = (sample: Array<Sample>): Array<Sample> => {
	if (
		sample.length !== reference.length ||
		sample.some(
			(row, index) =>
				row.name !== reference[index]!.name ||
				row.checksum !== reference[index]!.checksum,
		)
	) {
		throw new Error("forwarding workload checksum mismatch");
	}
	return sample;
};
check(run(result.binaryPath, []));
if (baseline !== undefined) check(run(baseline, []));
const samples: Array<Array<Sample>> = [];
const baseSamples: Array<Array<Sample>> = [];
for (let i = 0; i < 7; i++) {
	if (baseline !== undefined && i % 2 === 0) baseSamples.push(check(run(baseline, [])));
	samples.push(check(run(result.binaryPath, [])));
	if (baseline !== undefined && i % 2 !== 0) baseSamples.push(check(run(baseline, [])));
}
const cCompilationSamplesMs: Array<number> = [];
const { context } = result;
const includePaths = [
	"src",
	"src/host",
	"src/runtime",
	"rust/include",
	"vendor/llhttp/include",
]
	.map((directory) => path.join(context.runtimeDirectory, directory))
	.filter((directory) => existsSync(directory));
const compileFlags = [
	"-std=c2x",
	...ccExtraFlags(
		context.plan,
		context.environment,
		context.toolchain.platform ?? process.platform,
	),
	...context.features.cDefines,
	...includePaths.flatMap((directory) => ["-I", directory]),
	`-ffile-prefix-map=${context.runtimeDirectory}=<runtime>`,
];
const generatedCommands = readdirSync(outDir)
	.filter((file) => file.endsWith(".c"))
	.map((file) => ({
		tool: context.toolchain.tools.cc.path,
		args: toolArguments(context.toolchain.tools.cc, [
			...compileFlags,
			"-c",
			path.join(outDir, file),
			"-o",
			path.join(outDir, "cost.o"),
		]),
		cwd: process.cwd(),
	}));
if (generatedCommands.length > 0) {
	for (let sample = 0; sample < 5; sample++) {
		const started = performance.now();
		for (const [index, command] of generatedCommands.entries()) {
			const args = [...command.args];
			const outputIndex = args.indexOf("-o");
			if (outputIndex < 0) throw new Error("C compilation command has no output");
			args[outputIndex + 1] = path.join(outDir, `cost-${index}.o`);
			const compiled = spawnSync(command.tool, args, {
				encoding: "utf8",
				cwd: command.cwd,
				timeout: 120000,
			});
			if (compiled.status !== 0)
				throw new Error(compiled.stderr || String(compiled.error));
		}
		cCompilationSamplesMs.push(performance.now() - started);
	}
}
const memory = (binary: string) =>
	Array.from({ length: 3 }, () => {
		const output = spawnSync(
			"/usr/bin/time",
			[process.platform === "darwin" ? "-l" : "-v", binary],
			{
				env: { ...process.env, MAL_GC_STATS: "1" },
				encoding: "utf8",
				timeout: 120000,
			},
		);
		if (output.status !== 0) throw new Error(output.stderr || String(output.error));
		check(
			output.stdout
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Sample),
		);
		return output.stderr;
	});
const memorySamples = memory(result.binaryPath);
const baseMemorySamples = baseline === undefined ? [] : memory(baseline);
const report = {
	label,
	binary: result.binaryPath,
	baseline,
	config,
	buildMs,
	nativePlan: result.context.plan,
	toolchain: result.context.toolchain.fingerprint,
	resources,
	cCompilationSamplesMs,
	generatedCommands,
	memorySamples,
	baseMemorySamples,
	phases,
	node: process.version,
	platform: process.platform,
	arch: process.arch,
	reference,
	samples,
	baseSamples,
};
writeFileSync(path.join(outDir, "result.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
