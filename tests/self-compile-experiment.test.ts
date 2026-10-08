import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
import { digestSelfCompileOutput } from "../scripts/self-compile-workload.ts";
import { deserializeRuntimeImage } from "../src/compiler/target/program-image-codec.ts";

const script = path.resolve("scripts/self-compile-experiment.ts");
const digest = (value: string | Buffer) =>
	createHash("sha256").update(value).digest("hex");

function fixture(
	options: {
		wrongCandidate?: boolean;
		wrongRun?: string;
		hang?: string;
		wrongWireRun?: string;
		wireBytes?: number;
		missingWire?: boolean;
		truncatedWire?: boolean;
	} = {},
) {
	const root = mkdtempSync(path.join(os.tmpdir(), "mal-self-compile-experiment-"));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	const capture = (label: string) => {
		const directory = path.join(root, label);
		const files = {
			"source/package.json": '{"type":"module"}',
			"source/src/compiler/frontend/parser.ts": "frozen compiler input",
			"source/bench/self-compile.mts": `
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const target = process.argv[2];
const output = process.argv[3];
if (output.includes(${JSON.stringify(options.hang ?? "never-hang-here")})) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  writeFileSync(${JSON.stringify(path.join(root, "descendant.pid"))}, String(child.pid));
  console.log('controlled unfinished compiler output');
  setInterval(() => {}, 1000);
} else {
  const text = output.includes(${JSON.stringify(options.wrongRun ?? "never-wrong-here")}) ? 'incorrect output' : ${options.wrongCandidate && label === "candidate" ? "'incorrect output'" : "readFileSync(target, 'utf8')"};
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, 'unit.c'), text);
  const wire = new Uint8Array(output.includes(${JSON.stringify(options.wrongWireRun ?? "never-wrong-wire")}) ? [0, 254, 128] : [0, 255, 128]);
  if (!${options.missingWire ?? false}) writeFileSync(path.join(output, 'self-compile.malw'), ${options.truncatedWire ?? false} ? wire.subarray(0, 2) : wire);
  console.log(JSON.stringify({ units: 1, codeUnits: text.length, wireBytes: ${options.wireBytes ?? 3}, phases: {} }));
}
`,
			compiler: "unused native executable in a Node-hosted fixture",
		};
		for (const [name, contents] of Object.entries(files)) {
			mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
			writeFileSync(path.join(directory, name), contents);
		}
		const manifest = {
			schema: 5,
			kind: "native",
			closure: {
				scope: { kind: "whole-program", entry: "fixture" },
				sourceClosure: { kind: "known", value: "closed" },
			},
			status: "complete",
			source: { commit: label, digest: label },
			files: Object.fromEntries(
				Object.entries(files).map(([name, contents]) => [name, digest(contents)]),
			),
			preparation: "identical fixture preparation",
			lockfile: digest(readFileSync("package-lock.json")),
			host: {
				platform: process.platform,
				arch: process.arch,
				node: process.version,
				cpu: os.cpus()[0]?.model ?? "unknown",
			},
			build: { plan: { mode: "development" }, toolchain: "fixture", milliseconds: 0 },
		};
		writeFileSync(path.join(directory, "capture.json"), JSON.stringify(manifest));
		return directory;
	};
	const base = capture("base");
	const candidate = capture("candidate");
	const output = path.join(root, "result");
	const command = [
		script,
		"compare",
		base,
		candidate,
		"--host",
		"node",
		"--pairs",
		"2",
		"--output",
		output,
	];
	const run = (...args: Array<string>) =>
		spawnSync(process.execPath, [...command, ...args], {
			encoding: "utf8",
			timeout: 20_000,
		});
	const report = () =>
		JSON.parse(readFileSync(path.join(output, "report.json"), "utf8")) as {
			samples: Array<{
				label: string;
				digest: string;
				wireDigest: string;
				wireBytes: number;
			}>;
			pairs: Array<unknown>;
			target: string;
		};
	return { root, base, candidate, output, command, run, report };
}

async function expectProcessStopped(pid: number): Promise<void> {
	await expect
		.poll(() => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		})
		.toBe(false);
}

it("plans the oracle, warmups and paired work without writing or leasing a cache", () => {
	const test = fixture();
	const unusableCache = path.join(test.root, "cache-file");
	writeFileSync(unusableCache, "not a directory");
	const result = spawnSync(
		process.execPath,
		[
			script,
			"compare",
			test.base,
			test.candidate,
			"--output",
			test.output,
			"--plan=json",
		],
		{
			encoding: "utf8",
			env: { ...process.env, MALIGATOR_CACHE_DIR: unusableCache },
		},
	);
	expect(result.status, result.stderr).toBe(0);
	const plan = JSON.parse(result.stdout) as { work: Array<string> };
	expect(plan.work).toContain("one Node oracle");
	expect(plan.work).toContain("10 measured compiler runs");
	expect(existsSync(test.output)).toBe(false);
	expect(result.stderr).toBe("");
});

it("uses frozen input, alternates complete pairs and excludes warmups from statistics", () => {
	const test = fixture();
	const result = test.run();
	expect(result.status, result.stderr).toBe(0);
	const report = test.report();
	expect(report).toMatchObject({
		status: "complete",
		complete: true,
		summary: { pairs: 2 },
	});
	expect(report.samples.map((sample) => sample.label)).toEqual([
		"warm-base",
		"warm-candidate",
		"pair-0-base",
		"pair-0-candidate",
		"pair-1-candidate",
		"pair-1-base",
	]);
	expect(new Set(report.samples.map((sample) => sample.digest)).size).toBe(1);
	expect(report.pairs).toHaveLength(2);
	expect(report.target).toBe(
		path.join(test.base, "source/src/compiler/frontend/parser.ts"),
	);
	expect(readFileSync(path.join(test.output, "pair-1-base/output/unit.c"), "utf8")).toBe(
		"frozen compiler input",
	);
});

it("fails on a real output mismatch and preserves the failed output outside paired statistics", () => {
	const test = fixture({ wrongCandidate: true });
	expect(test.run().status).toBe(2);
	expect(test.report()).toMatchObject({ status: "failed", complete: false, pairs: [] });
	expect(readFileSync(path.join(test.output, "run.log"), "utf8")).toContain(
		"output differs from the frozen Node oracle",
	);
	expect(
		readFileSync(path.join(test.output, "warm-candidate/output/unit.c"), "utf8"),
	).toBe("incorrect output");
});

it("runs exactly three cold pairs with the first measured baseline as the frozen-input oracle", () => {
	const test = fixture();
	const result = test.run("--cold", "--pairs", "3");
	expect(result.status, result.stderr).toBe(0);
	const report = test.report();
	expect(report).toMatchObject({
		complete: true,
		summary: { pairs: 3 },
		options: { cold: true },
	});
	expect(report.samples.map((sample) => sample.label)).toEqual([
		"pair-0-base",
		"pair-0-candidate",
		"pair-1-candidate",
		"pair-1-base",
		"pair-2-base",
		"pair-2-candidate",
	]);
	expect(new Set(report.samples.map((sample) => sample.digest)).size).toBe(1);
	expect(new Set(report.samples.map((sample) => sample.wireDigest)).size).toBe(1);
	expect(report.samples.every((sample) => sample.wireBytes === 3)).toBe(true);
	expect(report.target).toBe(
		path.join(test.base, "source/src/compiler/frontend/parser.ts"),
	);
	expect(
		JSON.parse(readFileSync(path.join(test.output, "oracle.json"), "utf8")),
	).toMatchObject(report.samples[0]!);
	expect(existsSync(path.join(test.output, "node-reference"))).toBe(false);
	expect(existsSync(path.join(test.output, "warm-base"))).toBe(false);
	expect(existsSync(path.join(test.output, "warm-candidate"))).toBe(false);
});

it.each(["pair-0-candidate", "pair-1-base"])(
	"rejects a cold output mismatch in %s",
	(wrongRun) => {
		const test = fixture({ wrongRun });
		expect(test.run("--cold").status).toBe(2);
		expect(test.report()).toMatchObject({ status: "failed", complete: false });
		expect(readFileSync(path.join(test.output, "run.log"), "utf8")).toContain(
			"output differs from the frozen Node oracle",
		);
		expect(readFileSync(path.join(test.output, wrongRun, "output/unit.c"), "utf8")).toBe(
			"incorrect output",
		);
		expect(test.report().pairs).toHaveLength(wrongRun === "pair-0-candidate" ? 0 : 1);
	},
);

it.each(["pair-0-candidate", "pair-1-base"])(
	"rejects same-length binary runtime drift in %s even with identical C",
	(wrongWireRun) => {
		const test = fixture({ wrongWireRun });
		expect(test.run("--cold").status).toBe(2);
		const report = test.report();
		expect(report).toMatchObject({ status: "failed", complete: false });
		expect(new Set(report.samples.map((sample) => sample.digest)).size).toBe(1);
		expect(new Set(report.samples.map((sample) => sample.wireDigest)).size).toBe(2);
		expect(readFileSync(path.join(test.output, "run.log"), "utf8")).toContain(
			"runtime image differs from the frozen Node oracle",
		);
	},
);

it.each([{ missingWire: true }, { truncatedWire: true }, { wireBytes: 7 }])(
	"rejects incomplete or misreported runtime artifacts %j",
	(options) => {
		const test = fixture(options);
		expect(test.run("--cold").status).toBe(2);
		expect(test.report()).toMatchObject({ status: "failed", complete: false });
		expect(test.report().pairs).toHaveLength(0);
	},
);

it("rejects captures from the C-only protocol before running the compiler", () => {
	const test = fixture();
	const manifest = path.join(test.base, "capture.json");
	const capture = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
	capture.schema = 4;
	writeFileSync(manifest, JSON.stringify(capture));
	expect(test.run("--cold").status).toBe(2);
	expect(readFileSync(path.join(test.output, "run.log"), "utf8")).toContain(
		"incomplete or unsupported capture",
	);
	expect(existsSync(path.join(test.output, "pair-0-base"))).toBe(false);
});

it("emits a decodable runtime image alongside C and keeps C-only hashing independent", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "mal-self-compile-wire-"));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	const input = path.join(root, "input.mjs"),
		output = path.join(root, "output");
	writeFileSync(input, "export function add(a,b){return a+b;}");
	const run = spawnSync(
		process.execPath,
		[path.resolve("bench/self-compile.mts"), input, output],
		{
			encoding: "utf8",
			timeout: 20_000,
			env: {
				...process.env,
				MAL_CORE_INSTRUMENTATION: "off",
				MAL_CORE_BENCHMARK_ABLATION: undefined,
			},
		},
	);
	expect(run.status, run.stderr).toBe(0);
	const summary = JSON.parse(run.stdout) as { wireBytes: number };
	const wirePath = path.join(output, "self-compile.malw"),
		bytes = readFileSync(wirePath);
	expect(summary.wireBytes).toBe(bytes.length);
	const image = deserializeRuntimeImage(bytes);
	expect(image.entrypointPath).toBe(input);
	expect(image.files).toEqual([]);
	expect(
		image.functions.some(
			(fn) =>
				fn.parameterCount === 2 &&
				fn.instructions.some((op) => op.opcode === "BINARY" && op.operator === "+"),
		),
	).toBe(true);
	const cDigest = digestSelfCompileOutput(output);
	writeFileSync(wirePath, new Uint8Array([0, 255, 128]));
	expect(digestSelfCompileOutput(output)).toBe(cDigest);
});

it("plans cold work and rejects a native cold protocol before running any compiler", () => {
	const test = fixture();
	const result = test.run("--cold", "--pairs", "3", "--plan=json");
	expect(result.status, result.stderr).toBe(0);
	const plan = JSON.parse(result.stdout) as { work: Array<string> };
	expect(plan.work).toEqual(
		expect.arrayContaining([
			"first measured baseline is the Node oracle",
			"zero warmups",
			"6 measured compiler runs",
		]),
	);
	expect(existsSync(test.output)).toBe(false);
	const native = test.run("--cold", "--host", "native");
	expect(native.status).toBe(2);
	expect(native.stderr).toContain("--cold requires --host node");
	expect(existsSync(test.output)).toBe(false);
});

it.each(["compiler", "source/src/compiler/frontend/parser.ts"])(
	"refuses a modified capture %s before running an oracle",
	(file) => {
		const test = fixture();
		writeFileSync(path.join(test.candidate, file), "tampered");
		expect(test.run().status).toBe(2);
		expect(readFileSync(path.join(test.output, "run.log"), "utf8")).toContain(
			"capture contents changed",
		);
		expect(existsSync(path.join(test.output, "node-reference"))).toBe(false);
	},
);

it("rejects different source preparation even when each capture is internally intact", () => {
	const test = fixture();
	const manifest = path.join(test.candidate, "capture.json");
	const capture = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
	capture.preparation = "different stripping implementation";
	writeFileSync(manifest, JSON.stringify(capture));
	expect(test.run().status).toBe(2);
	expect(readFileSync(path.join(test.output, "run.log"), "utf8")).toContain(
		"capture preparation or native toolchain/build plans differ",
	);
});

it("refuses an uncertified capture before running an oracle", () => {
	const test = fixture();
	const manifest = path.join(test.candidate, "capture.json");
	const capture = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
	delete capture.closure;
	writeFileSync(manifest, JSON.stringify(capture));
	expect(test.run().status).toBe(2);
	expect(readFileSync(path.join(test.output, "run.log"), "utf8")).toContain(
		"capture lacks certified source closure",
	);
	expect(existsSync(path.join(test.output, "node-reference"))).toBe(false);
});

it("rejects a modified frozen program before building another compiler", () => {
	const test = fixture();
	writeFileSync(path.join(test.base, "source/bench/self-compile.mts"), "tampered");
	const result = spawnSync(
		process.execPath,
		[script, "capture", test.output, "--program", test.base],
		{
			encoding: "utf8",
			timeout: 20_000,
		},
	);
	expect(result.status, result.stderr).toBe(2);
	expect(readFileSync(path.join(test.output, "run.log"), "utf8")).toContain(
		"capture contents changed",
	);
	expect(existsSync(path.join(test.output, "source"))).toBe(false);
	expect(existsSync(path.join(test.output, "compiler"))).toBe(false);
});

it("kills a timed-out compiler process group and retains only complete pairs in statistics", async () => {
	const test = fixture({ hang: "pair-1-base" });
	expect(test.run("--budget-seconds", "10").status).toBe(2);
	expect(test.report()).toMatchObject({
		status: "incomplete",
		complete: false,
		summary: { pairs: 1 },
	});
	expect(test.report().samples).toHaveLength(5);
	expect(
		readFileSync(path.join(test.output, "pair-1-base/stdout.json"), "utf8"),
	).toContain("controlled unfinished compiler output");
	const pid = Number(readFileSync(path.join(test.root, "descendant.pid"), "utf8"));
	await expectProcessStopped(pid);
});

it.each(["SIGINT", "SIGTERM"] as const)(
	"retains an incomplete report and stops descendants on %s",
	async (signal) => {
		const test = fixture({ hang: "pair-1-base" });
		const child = spawn(process.execPath, [...test.command, "--budget-seconds", "20"], {
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		const closed = new Promise<number | null>((resolve, reject) => {
			child.once("close", resolve);
			child.once("error", reject);
		});
		onTestFinished(async () => {
			if (child.exitCode === null) child.kill("SIGTERM");
			await closed;
		});
		const pidFile = path.join(test.root, "descendant.pid");
		await expect.poll(() => existsSync(pidFile)).toBe(true);
		const pid = Number(readFileSync(pidFile, "utf8"));
		child.kill(signal);
		const code = await closed;
		expect(code, stderr).toBe(2);
		expect(test.report()).toMatchObject({
			status: "incomplete",
			complete: false,
			summary: { pairs: 1 },
		});
		await expectProcessStopped(pid);
	},
);

it("accepts source-only captures for Node comparisons and rejects native execution before the oracle", () => {
	const test = fixture();
	for (const directory of [test.base, test.candidate]) {
		const manifest = path.join(directory, "capture.json");
		const capture = JSON.parse(readFileSync(manifest, "utf8")) as {
			kind: string;
			files: Record<string, string>;
			closure?: unknown;
			build?: unknown;
		};
		capture.kind = "node";
		delete capture.files.compiler;
		delete capture.closure;
		delete capture.build;
		rmSync(path.join(directory, "compiler"));
		writeFileSync(manifest, JSON.stringify(capture));
	}
	const completed = test.run();
	expect(completed.status, completed.stderr).toBe(0);
	expect(test.report()).toMatchObject({ complete: true, summary: { pairs: 2 } });
	rmSync(test.output, { recursive: true });
	expect(test.run("--host", "native").status).toBe(2);
	expect(readFileSync(path.join(test.output, "run.log"), "utf8")).toContain(
		"requires two native compiler captures",
	);
	expect(existsSync(path.join(test.output, "node-reference"))).toBe(false);
});
