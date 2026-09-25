import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import {
	classifyMetricSamples,
	lanesForChangedFiles,
	runBenchmarkComparison,
} from "../scripts/bench-compare.ts";

function comparisonFixture() {
	const root = mkdtempSync(path.join(os.tmpdir(), "mal-comparison-test-"));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	const repository = path.join(root, "repository");
	mkdirSync(path.join(repository, "scripts"), { recursive: true });
	copyFileSync(
		"tests/fixtures/bench-comparison/runner.mts",
		path.join(repository, "scripts/bench.ts"),
	);
	writeFileSync(path.join(repository, "package-lock.json"), "{}");
	writeFileSync(path.join(repository, ".gitignore"), ".cache/\n");
	writeFileSync(path.join(repository, "control-path.json"), JSON.stringify(root));
	const control = (value: Record<string, unknown>) =>
		writeFileSync(path.join(root, "control.json"), JSON.stringify(value));
	control({});
	const git = (...args: Array<string>) =>
		execFileSync("git", args, { cwd: repository, stdio: "pipe" });
	git("init", "--quiet");
	git("add", ".");
	git(
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"--no-gpg-sign",
		"-qm",
		"fixture",
	);
	return {
		root,
		repository,
		control,
		options: {
			repository,
			baseRef: "HEAD",
			lanes: ["javascript"],
			pairs: 2,
			maxPairs: 2,
		},
	};
}

test("failed comparisons preserve complete snapshots and resume without replaying them", async () => {
	const fixture = comparisonFixture();
	fixture.control({ fail: "pair-1-head" });
	const failed = await runBenchmarkComparison(fixture.options);
	expect(failed.exitCode).toBe(2);
	const directory = path.dirname(failed.reportPath);
	expect(JSON.parse(readFileSync(failed.reportPath, "utf8"))).toMatchObject({
		status: "failed",
		complete: false,
		completedPairs: 1,
	});
	expect(
		JSON.parse(readFileSync(path.join(directory, "pair-0-head.json"), "utf8")),
	).toMatchObject({
		source: { commit: "candidate" },
		nativePlan: { compiler: "fixture" },
		javascript: { phaseChecksums: { main: 42 } },
	});
	expect(readFileSync(path.join(directory, "pair-1-head.log"), "utf8")).toContain(
		"controlled benchmark failure",
	);
	fixture.control({});
	const completed = await runBenchmarkComparison({
		...fixture.options,
		resumeDirectory: directory,
	});
	expect(completed.exitCode).toBe(0);
	expect(JSON.parse(readFileSync(completed.reportPath, "utf8"))).toMatchObject({
		status: "complete",
		completedPairs: 2,
		unpairedMetrics: ["nativeBuild.peakRssBytes"],
	});
	const calls = readFileSync(path.join(fixture.root, "calls.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as string);
	expect(calls.filter((label) => label === "pair-0-head")).toHaveLength(1);
	expect(calls.filter((label) => label === "pair-1-head")).toHaveLength(2);
	expect(existsSync(path.join(directory, "base"))).toBe(false);
});

test("a budget stops the benchmark process group and leaves a resumable checkpoint", async () => {
	const fixture = comparisonFixture();
	fixture.control({ hang: "warm-head" });
	const options = {
		...fixture.options,
		lanes: ["self-compile"],
		pairs: 1,
		maxPairs: 1,
	};
	const pidFile = path.join(fixture.root, "descendant.pid");
	const realSetTimeout = setTimeout;
	let result: Awaited<ReturnType<typeof runBenchmarkComparison>>;
	vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
	try {
		const deadline = performance.now() + 3_000;
		const pending = runBenchmarkComparison({ ...options, budgetSeconds: 3 });
		try {
			// Expire the clock after the real process group is ready, without an idle wait.
			const readyDeadline = Date.now() + 5_000;
			while (!existsSync(pidFile) && Date.now() < readyDeadline) {
				await new Promise<void>((resolve) => {
					realSetTimeout(resolve, 10);
				});
			}
			expect(existsSync(pidFile)).toBe(true);
			vi.advanceTimersByTime(2_999);
			expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).not.toThrow();
		} finally {
			vi.advanceTimersByTime(deadline - performance.now());
			result = await pending;
		}
	} finally {
		vi.useRealTimers();
	}
	expect(result.exitCode).toBe(2);
	const directory = path.dirname(result.reportPath);
	expect(JSON.parse(readFileSync(result.reportPath, "utf8"))).toMatchObject({
		status: "incomplete",
		complete: false,
		completedPairs: 0,
	});
	expect(existsSync(path.join(directory, "warm-base.checkpoint.json"))).toBe(true);
	const pid = Number(readFileSync(pidFile, "utf8"));
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
	fixture.control({});
	const resumed = await runBenchmarkComparison({
		...options,
		resumeDirectory: directory,
	});
	expect(resumed.exitCode).toBe(0);
	expect(existsSync(path.join(directory, "warm-base.json"))).toBe(true);
}, 30_000);

test("resuming refuses changed source before reusing evidence", async () => {
	const fixture = comparisonFixture();
	fixture.control({ fail: "warm-head" });
	const result = await runBenchmarkComparison(fixture.options);
	writeFileSync(
		path.join(fixture.repository, "new-source.ts"),
		"export const changed = true;\n",
	);
	await expect(
		runBenchmarkComparison({
			...fixture.options,
			resumeDirectory: path.dirname(result.reportPath),
		}),
	).rejects.toThrow("source, options, or host changed");
});

test("a workload mismatch is retained as failed evidence rather than a speedup", async () => {
	const fixture = comparisonFixture();
	fixture.control({ checksumMismatch: true });
	const result = await runBenchmarkComparison({
		...fixture.options,
		pairs: 1,
		maxPairs: 1,
	});
	expect(result.exitCode).toBe(2);
	expect(JSON.parse(readFileSync(result.reportPath, "utf8"))).toMatchObject({
		status: "failed",
		completedPairs: 0,
		error: "base/head JavaScript workload or checksums differ",
	});
	expect(result.metrics).toEqual([]);
});

test("source changes during execution invalidate resumption even after source restoration", async () => {
	const fixture = comparisonFixture();
	fixture.control({ mutate: "warm-head" });
	const result = await runBenchmarkComparison(fixture.options);
	expect(JSON.parse(readFileSync(result.reportPath, "utf8"))).toMatchObject({
		status: "failed",
		resumeAllowed: false,
	});
	rmSync(path.join(fixture.repository, "changed-during-bench.ts"));
	await expect(
		runBenchmarkComparison({
			...fixture.options,
			resumeDirectory: path.dirname(result.reportPath),
		}),
	).rejects.toThrow("source, options, or host changed");
});

test("changed source files select transparent benchmark lanes", () => {
	const lanes = ["javascript", "http", "self-compile"];
	expect(lanesForChangedFiles(["runtime/src/builtin_string.c"], lanes)).toEqual([
		"javascript",
		"http",
	]);
	expect(lanesForChangedFiles(["src/compiler/core/optimize.ts"], lanes)).toEqual([
		"javascript",
		"http",
		"self-compile",
	]);
	expect(lanesForChangedFiles(["README.md"], lanes)).toEqual([]);
});

test("paired comparison recognizes small consistent slowdowns", () => {
	const slowdown = Array.from({ length: 7 }, (_, index) => ({
		base: 100 + index * 0.1,
		head: 110 + index * 0.1,
	}));
	const small = Array.from({ length: 7 }, (_, index) => ({
		base: 100 + index * 0.1,
		head: 101 + index * 0.1,
	}));
	expect(
		classifyMetricSamples("javascript.modes.closed-compiled.wallMs", slowdown)?.status,
	).toBe("regression");
	expect(
		classifyMetricSamples("javascript.modes.closed-compiled.wallMs", small)?.status,
	).toBe("regression");
});

test("paired comparison gives time and throughput ratios opposite directions", () => {
	const lower = Array.from({ length: 7 }, () => ({ base: 2, head: 1 }));
	const higher = Array.from({ length: 7 }, () => ({ base: 1, head: 2 }));
	expect(
		classifyMetricSamples("javascript.modes.closed-compiled.ratio", lower)?.status,
	).toBe("improvement");
	expect(classifyMetricSamples("http.bare.ratio", higher)?.status).toBe("improvement");
	expect(
		classifyMetricSamples("http.express.workloads.routes.ratio", higher)?.status,
	).toBe("improvement");
});

test("paired comparison retains confident sub-percent time and throughput gains", () => {
	const improvement = Array.from({ length: 7 }, (_, index) => ({
		base: 100 + index * 0.01,
		head: 99.5 + index * 0.01,
	}));
	const throughput = Array.from({ length: 7 }, (_, index) => ({
		base: 100 + index * 0.01,
		head: 100.5 + index * 0.01,
	}));
	expect(
		classifyMetricSamples("javascript.modes.open-interpreted.phaseMs.text", improvement)
			?.status,
	).toBe("improvement");
	expect(classifyMetricSamples("http.bare.malRps", throughput)?.status).toBe(
		"improvement",
	);
});

test("small improvements require an interval excluding zero", () => {
	const improvements = [-0.4, -0.6, -0.8, -0.9, -1.1, -1.2, -1.4].map((change) => ({
		base: 100,
		head: 100 + change,
	}));
	const result = classifyMetricSamples(
		"javascript.modes.closed-compiled.wallMs",
		improvements,
	);
	expect(result?.medianRegressionPercent).toBeGreaterThan(-2);
	expect(result?.confidenceInterval[1]).toBeLessThan(0);
	expect(result?.status).toBe("improvement");
});

test("paired comparison treats exact A/A as unchanged and noisy evidence as inconclusive", () => {
	const equal = Array.from({ length: 5 }, () => ({ base: 100, head: 100 }));
	const noisy = [
		{ base: 100, head: 90 },
		{ base: 100, head: 110 },
		{ base: 100, head: 91 },
		{ base: 100, head: 109 },
		{ base: 100, head: 100 },
	];
	expect(
		classifyMetricSamples("javascript.modes.closed-compiled.wallMs", equal)?.status,
	).toBe("unchanged");
	expect(
		classifyMetricSamples("javascript.modes.closed-compiled.wallMs", noisy)?.status,
	).toBe("inconclusive");
});

test("binary size requires both percentage and practical byte movement", () => {
	const samples = Array.from({ length: 7 }, () => ({
		base: 1_000_000,
		head: 1_010_000,
	}));
	expect(
		classifyMetricSamples("javascript.modes.closed-compiled.binaryBytes", samples)
			?.status,
	).toBe("unchanged");
});

test("paired comparison ignores reference-engine timing noise", () => {
	const samples = Array.from({ length: 7 }, () => ({ base: 100, head: 200 }));
	expect(classifyMetricSamples("javascript.node.wallMs", samples)).toBeUndefined();
	expect(classifyMetricSamples("http.bare.nodeP99Ms", samples)).toBeUndefined();
});
