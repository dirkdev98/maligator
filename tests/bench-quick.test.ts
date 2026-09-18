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
	failure: "none" | "output" | "self-compile-output" | "timeout" = "none",
) {
	const root = mkdtempSync(path.join(os.tmpdir(), "mal-bench-quick-"));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	const checkout = (label: string) => {
		const directory = path.join(root, label);
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
writeFileSync(binary, ${JSON.stringify(`#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
const output = process.argv[3];
mkdirSync(output, { recursive: true });
writeFileSync(path.join(output, 'self-compile-output.c'), ${JSON.stringify(
				failure === "self-compile-output" && label === "candidate"
					? "deterministic native miscompile"
					: `${label} node output`,
			)});
`)});
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
				timeout: 20_000,
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
			samples: Array<{ label: string; peakRssBytes: number }>;
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
	expect(report.samples.map((sample) => sample.label)).toEqual([
		"warm-baseline",
		"warm-candidate",
		"pair-0-baseline",
		"pair-0-candidate",
		"pair-1-candidate",
		"pair-1-baseline",
	]);
	for (const sample of report.samples) expect(sample.peakRssBytes).toBeGreaterThan(0);
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
