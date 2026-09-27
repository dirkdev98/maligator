import { execFileSync } from "node:child_process";
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
import { expect, onTestFinished, test, vi } from "vitest";

const diagnostic = vi.hoisted(() => ({
	failOnCall: 2 as number | undefined,
	calls: 0,
	ordinaryCalls: 0,
}));

vi.mock("../scripts/bench-http-ordinary.ts", () => ({
	prepareHttpBinaries: () => ({
		binaries: {
			base: { bare: "base-bare", express: "base-express" },
			head: { bare: "head-bare", express: "head-express" },
		},
		identity: { fixtures: {}, configurations: {}, binaries: {}, tools: {} },
	}),
	runHttpSnapshot: () => {
		diagnostic.ordinaryCalls++;
		return { http: { oracleDigest: "fixture", bare: { malRps: 100, nodeRps: 100 } } };
	},
	runHttpGcDiagnostic: () => {
		diagnostic.calls++;
		if (diagnostic.calls === diagnostic.failOnCall)
			throw new Error("controlled diagnostic failure");
		return { status: "complete", gc: { delta: { collections: 1 } } };
	},
}));

import { runBenchmarkComparison } from "../scripts/bench-compare.ts";

test("a failed HTTP GC diagnostic preserves and resumes the complete ordinary comparison", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "mal-http-comparison-"));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	const repository = path.join(root, "repository");
	mkdirSync(repository);
	writeFileSync(path.join(repository, "package-lock.json"), "{}\n");
	writeFileSync(path.join(repository, ".gitignore"), ".cache/\n");
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
	const options = {
		baseRef: "HEAD",
		lanes: ["http"],
		pairs: 1,
		maxPairs: 1,
		repository,
		httpGcDiagnostics: true,
	};
	diagnostic.failOnCall = 2;
	diagnostic.calls = 0;
	diagnostic.ordinaryCalls = 0;
	const failed = await runBenchmarkComparison(options);
	expect(failed.exitCode).toBe(2);
	const directory = path.dirname(failed.reportPath);
	const report = JSON.parse(readFileSync(failed.reportPath, "utf8")) as {
		metrics: Array<unknown>;
	};
	expect(report).toMatchObject({
		status: "complete",
		complete: true,
		ordinaryComplete: true,
		completedPairs: 1,
		resumeAllowed: true,
		httpGcDiagnostics: {
			status: "failed",
			error: "controlled diagnostic failure",
			results: { base: { gc: { delta: { collections: 1 } } } },
		},
	});
	expect(report.metrics).toHaveLength(1);
	expect(existsSync(path.join(directory, "ordinary-report.json"))).toBe(true);
	expect(
		JSON.parse(readFileSync(path.join(directory, "ordinary-report.json"), "utf8")),
	).toMatchObject({ complete: true, completedPairs: 1 });
	for (const label of ["warm-base", "warm-head", "pair-0-base", "pair-0-head"])
		expect(existsSync(path.join(directory, `${label}.json`))).toBe(true);
	expect(existsSync(path.join(directory, "http-gc-base.json"))).toBe(true);
	expect(existsSync(path.join(directory, "http-gc-head.json"))).toBe(false);
	expect(diagnostic.ordinaryCalls).toBe(4);
	diagnostic.failOnCall = undefined;
	const resumed = await runBenchmarkComparison({
		...options,
		resumeDirectory: directory,
	});
	expect(resumed.exitCode).toBe(0);
	expect(diagnostic.calls).toBe(3);
	expect(diagnostic.ordinaryCalls).toBe(4);
	expect(JSON.parse(readFileSync(resumed.reportPath, "utf8"))).toMatchObject({
		status: "complete",
		completedPairs: 1,
		httpGcDiagnostics: {
			status: "complete",
			results: {
				base: { gc: { delta: { collections: 1 } } },
				head: { gc: { delta: { collections: 1 } } },
			},
		},
	});
});
