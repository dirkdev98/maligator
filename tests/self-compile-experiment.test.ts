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

const script = path.resolve("scripts/self-compile-experiment.ts");
const digest = (value: string | Buffer) =>
	createHash("sha256").update(value).digest("hex");

function fixture(options: { wrongCandidate?: boolean; hang?: string } = {}) {
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
  const text = ${options.wrongCandidate && label === "candidate" ? "'incorrect output'" : "readFileSync(target, 'utf8')"};
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, 'unit.c'), text);
  console.log(JSON.stringify({ units: 1, codeUnits: text.length, phases: {} }));
}
`,
			compiler: "unused native executable in a Node-hosted fixture",
		};
		for (const [name, contents] of Object.entries(files)) {
			mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
			writeFileSync(path.join(directory, name), contents);
		}
		const manifest = {
			schema: 4,
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
			samples: Array<{ label: string; digest: string }>;
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
