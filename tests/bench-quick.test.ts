import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it, onTestFinished } from "vitest";

const script = path.resolve("scripts/bench-quick.ts");
function fixture(
	failure:
		| "none"
		| "output"
		| "self-compile-output"
		| "timeout"
		| "app"
		| "app-long-output" = "none",
) {
	const root = mkdtempSync(path.join(os.tmpdir(), "mal-bench-quick-"));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	const checkout = (label: string) => {
		const directory = path.join(root, label);
		const appBinary = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
const iterations = Number(process.argv[3]);
const result = spawnSync(process.execPath, [path.join(process.cwd(), 'app-batch.mts'), ...process.argv.slice(2)], { encoding: 'utf8' });
if (result.status !== 0) throw new Error(result.stderr);
if (${JSON.stringify(failure === "app-long-output" && label === "candidate")} && iterations === 2000) {
  const observed = JSON.parse(result.stdout);
  observed.checksum++;
  process.stdout.write(JSON.stringify(observed) + '\\n');
} else process.stdout.write(result.stdout);
if (process.env.MAL_GC_STATS === '1') process.stderr.write('[gc-stats] collections=' + Math.ceil(iterations / 100) + '\\n');
`;
		const selfCompileBinary = `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
const output = process.argv[3];
mkdirSync(output, { recursive: true });
writeFileSync(path.join(output, 'self-compile-output.c'), ${JSON.stringify(
			failure === "self-compile-output" && label === "candidate"
				? "deterministic native miscompile"
				: `${label} node output`,
		)});
`;
		const files = {
			"package.json": '{"type":"module"}',
			"package-lock.json": '{"lockfileVersion":3}',
			".gitignore": "node_modules/\n.cache/\n",
			"bench/self-compile.mts": `
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
const output = process.argv[3];
mkdirSync(output, { recursive: true });
writeFileSync(path.join(output, 'self-compile-output.c'), ${JSON.stringify(`${label} node output`)});
`,
			"src/index.ts": `
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
const artifact = process.argv[process.argv.indexOf('--artifact') + 1];
const name = 'self-compile-fixture';
const binary = path.join(artifact, 'bin', name);
mkdirSync(path.dirname(binary), { recursive: true });
writeFileSync(binary, ${JSON.stringify(failure === "app" || failure === "app-long-output" ? appBinary : selfCompileBinary)});
chmodSync(binary, 0o755);
writeFileSync(path.join(artifact, 'artifact.json'), JSON.stringify({ name, production: true }));
`,
			"src/build-config.ts": "export const resolveBuildConfig = (config) => config;",
			"src/compiler/frontend/compact-type-strip.ts":
				"export const stripCompactTypes = (source) => source;",
			"src/compiler/target/emit-program-image.ts":
				"export const emitProgramTranslationUnits = (image) => [{ id: 'runtime-image', source: image }];",
			"src/compiler/pipeline/compile-program.ts": `
import { readFileSync } from 'node:fs';
export function compileEntrypoint(input) {
  if (${JSON.stringify(failure === "timeout" && label === "baseline")} && process.argv[4].includes('pair-1-baseline')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
  return ${failure === "output" && label === "candidate" ? "process.argv[4].includes('warm-candidate') ? 'first generated output' : 'changed generated output'" : "readFileSync(input, 'utf8')"};
}
`,
			"tests/fixtures/express-5/app.js": `frozen ${label} application input`,
		};
		for (const [file, content] of Object.entries(files)) {
			mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
			writeFileSync(path.join(directory, file), content);
		}
		mkdirSync(path.join(directory, "node_modules"));
		const git = (...args: Array<string>) =>
			execFileSync("git", args, { cwd: directory, stdio: "ignore" });
		git("init", "-q");
		git("add", ".");
		git(
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@localhost",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-qm",
			label,
		);
		return directory;
	};
	const baseline = checkout("baseline");
	const candidate = checkout("candidate");
	const tools = path.join(root, "tools");
	mkdirSync(tools);
	for (const tool of ["cc", "rustc"]) {
		const executable = path.join(tools, tool);
		writeFileSync(executable, `#!/bin/sh\necho ${tool} fixture\n`);
		chmodSync(executable, 0o755);
	}
	const output = path.join(root, "result");
	const run = (...extra: Array<string>) =>
		spawnSync(
			process.execPath,
			[
				script,
				"--baseline",
				baseline,
				"--candidate",
				candidate,
				"--output",
				output,
				"--pairs",
				"2",
				...extra,
			],
			{
				encoding: "utf8",
				timeout: 60_000,
				env: {
					...process.env,
					CC: "cc",
					PATH: `${tools}${path.delimiter}${process.env.PATH}`,
				},
			},
		);
	const report = () =>
		JSON.parse(readFileSync(path.join(output, "report.json"), "utf8")) as {
			status: string;
			complete: boolean;
			ordinaryComplete: boolean;
			inputDigest: string;
			gcResourcesStatus: string;
			gcResourceOracles: Record<string, string>;
			gcResources: Array<{
				label: string;
				revision: string;
				iterations: number;
				workloadDigest: string;
				oracleDigest: string;
				instrumentation: string;
			}>;
			samples: Array<{ label: string; cpuMs: number; peakRssBytes: number }>;
			summary?: { pairs: number; baselineMedianCpuMs: number };
			pairs: Array<unknown>;
			error?: string;
		};
	return { baseline, candidate, output, run, report };
}

it("plans explicit quick work without preparing sources or writing output", () => {
	const test = fixture();
	const result = test.run("--plan=json");
	expect(result.status, result.stderr).toBe(0);
	expect(JSON.parse(result.stdout)).toMatchObject({
		pairs: 2,
		budgetIncludesPreparation: true,
	});
	expect(existsSync(test.output)).toBe(false);
});

it("plans one prepared self-hosted compiler pair loop without diagnostic repetitions", () => {
	const test = fixture();
	const result = test.run("--workload", "self-compile", "--plan=json");
	expect(result.status, result.stderr).toBe(0);
	expect(JSON.parse(result.stdout)).toMatchObject({
		workload: "self-compile",
		work: [
			"freeze the baseline compiler graph and build two self-hosted compilers once",
			"revision-specific Node output oracles",
			"one warmup per revision",
			"2 alternating pairs with output validation",
		],
	});
	expect(existsSync(test.output)).toBe(false);
});

it("plans app-batch timing and both separate GC resource durations", () => {
	const test = fixture("app");
	const result = test.run("--workload", "app-batch", "--plan=json");
	expect(result.status, result.stderr).toBe(0);
	expect(JSON.parse(result.stdout)).toMatchObject({
		workload: "app-batch",
		work: [
			"freeze dataset and build two production binaries once",
			"output oracle",
			"one warmup per revision",
			"2 alternating pairs with output validation",
			"save ordinary evidence before diagnostics",
			"one 2000-iteration Node oracle after timing",
			"one separate GC resource sample per revision at 200 and 2000 iterations",
		],
	});
});

it("keeps app-batch timing separate from 200 and 2000 iteration resource samples", () => {
	const test = fixture("app");
	const preparation = test.run("--workload", "app-batch", "--prepare-only");
	expect(preparation.status, preparation.stderr).toBe(0);
	const output = `${test.output}-measured`;
	const result = test.run(
		"--workload",
		"app-batch",
		"--prepared",
		path.join(test.output, "prepared"),
		"--output",
		output,
		"--pairs",
		"1",
		"--budget-seconds",
		"90",
	);
	expect(result.status, result.stderr).toBe(0);
	expect(result.stdout).not.toContain("build-baseline:");
	const report = JSON.parse(
		readFileSync(path.join(output, "report.json"), "utf8"),
	) as ReturnType<typeof test.report>;
	expect(report).toMatchObject({
		status: "complete",
		ordinaryComplete: true,
		gcResourcesStatus: "complete",
		summary: { pairs: 1 },
	});
	expect(report.samples.map((sample) => sample.label)).toEqual([
		"warm-baseline",
		"warm-candidate",
		"pair-0-baseline",
		"pair-0-candidate",
	]);
	expect(
		report.gcResources.map((sample) => [sample.revision, sample.iterations]),
	).toEqual([
		["baseline", 200],
		["candidate", 200],
		["baseline", 2000],
		["candidate", 2000],
	]);
	expect(report.gcResourceOracles["200"]).not.toBe(report.gcResourceOracles["2000"]);
	expect(report.gcResources[0]?.workloadDigest).toBe(report.inputDigest);
	expect(report.gcResources[1]?.workloadDigest).toBe(report.inputDigest);
	expect(report.gcResources[2]?.workloadDigest).not.toBe(report.inputDigest);
	for (const sample of report.gcResources) {
		expect(sample.oracleDigest).toBe(report.gcResourceOracles[String(sample.iterations)]);
		expect(sample.instrumentation).toBe("gc-stats");
	}
	expect(
		JSON.parse(readFileSync(path.join(output, "ordinary-report.json"), "utf8")),
	).toMatchObject({
		status: "complete",
		ordinaryComplete: true,
		gcResourcesStatus: "not-started",
		gcResources: [],
	});
});

it("retains complete ordinary app-batch evidence when only the long diagnostic mismatches", () => {
	const test = fixture("app-long-output");
	const result = test.run(
		"--workload",
		"app-batch",
		"--pairs",
		"1",
		"--budget-seconds",
		"90",
	);
	expect(result.status, result.stderr).toBe(2);
	expect(test.report()).toMatchObject({
		status: "failed",
		ordinaryComplete: true,
		gcResourcesStatus: "failed",
		summary: { pairs: 1 },
	});
	expect(test.report().error).toContain(
		"gc-resource-2000-candidate differs from the Node oracle",
	);
	expect(test.report().gcResources.map((sample) => sample.iterations)).toEqual([
		200, 200, 2000,
	]);
	expect(
		JSON.parse(readFileSync(path.join(test.output, "ordinary-report.json"), "utf8")),
	).toMatchObject({
		status: "complete",
		ordinaryComplete: true,
		pairs: [expect.any(Object)],
	});
});

it("rejects a deterministic native self-compile miscompile against its revision's Node oracle", () => {
	const test = fixture("self-compile-output");
	const result = test.run(
		"--workload",
		"self-compile",
		"--pairs",
		"1",
		"--budget-seconds",
		"20",
	);
	expect(result.status, result.stderr).toBe(2);
	expect(test.report()).toMatchObject({
		status: "failed",
		complete: false,
		pairs: [],
	});
	expect(test.report().error).toContain(
		"warm-candidate output differs from the candidate frozen reference",
	);
	expect(
		readFileSync(
			path.join(test.output, "node-oracle-candidate/output/self-compile-output.c"),
			"utf8",
		),
	).toBe("candidate node output");
	expect(
		readFileSync(
			path.join(test.output, "warm-candidate/output/self-compile-output.c"),
			"utf8",
		),
	).toBe("deterministic native miscompile");
});

it("compares both compiler revisions on frozen baseline input, preserving alternating pairs and peak RSS", () => {
	const test = fixture();
	const result = test.run();
	expect(result.status, result.stderr).toBe(0);
	const report = test.report();
	expect(report).toMatchObject({
		complete: true,
		status: "complete",
		summary: { pairs: 2 },
	});
	expect(report.summary?.baselineMedianCpuMs).toBeGreaterThan(0);
	expect(report.samples.map((sample) => sample.label)).toEqual([
		"warm-baseline",
		"warm-candidate",
		"pair-0-baseline",
		"pair-0-candidate",
		"pair-1-candidate",
		"pair-1-baseline",
	]);
	for (const sample of report.samples) {
		expect(sample.cpuMs).toBeGreaterThan(0);
		expect(sample.peakRssBytes).toBeGreaterThan(0);
	}
	expect(
		readFileSync(
			path.join(test.output, "pair-1-candidate/output/unit-runtime-image.c"),
			"utf8",
		),
	).toBe("frozen baseline application input");
});

it("permits output changes between compilers but rejects changes within one revision", () => {
	const test = fixture("output");
	expect(test.run().status).toBe(2);
	expect(test.report()).toMatchObject({
		status: "failed",
		complete: false,
		pairs: [],
	});
	expect(test.report().error).toContain("output differs");
	expect(
		readFileSync(
			path.join(test.output, "pair-0-candidate/output/unit-runtime-image.c"),
			"utf8",
		),
	).toBe("changed generated output");
});

it("stops at the total budget and retains complete pairs plus partial evidence", () => {
	const test = fixture("timeout");
	expect(test.run("--budget-seconds", "6").status).toBe(2);
	expect(test.report()).toMatchObject({
		status: "incomplete",
		complete: false,
		summary: { pairs: 1 },
	});
	expect(test.report().samples).toHaveLength(5);
});
