import { execFileSync, spawnSync } from "node:child_process";
import {
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
import { describe, expect, it, vi } from "vitest";
import { combineCheckReports } from "../scripts/test-suite-ci.ts";
import {
	captureVerificationEnvironment,
	captureVerificationSource,
} from "../scripts/verification-source.ts";

const root = path.resolve(import.meta.dirname, "..");
type Plan = Parameters<typeof combineCheckReports>[1];
type Shard = { index: number; count: number };
function planFor(...args: Array<string>): Plan {
	return JSON.parse(
		execFileSync(
			process.execPath,
			["scripts/test-suite.ts", "check", "--workers", "4", ...args, "--plan=json"],
			{ cwd: root, encoding: "utf8" },
		),
	) as Plan;
}
const plan = planFor();
const shardPlans = new Map<string, Plan["stages"]>();
function shardPlan(lane: string, shard: Shard): Plan["stages"] {
	const key = `${lane} ${shard.index}/${shard.count}`;
	if (!shardPlans.has(key)) {
		shardPlans.set(
			key,
			planFor("--lane", lane, "--shard", `${shard.index}/${shard.count}`).stages,
		);
	}
	return shardPlans.get(key)!;
}
const source = { revision: "1234", digest: "a".repeat(64), dirty: false, files: 1 };
const environment = {
	platform: process.platform,
	arch: process.arch,
	node: process.version,
	cc: { command: "cc", version: "Clang fixture" },
	rustc: { version: "rustc fixture", toolchain: null },
};

function reports(
	identity: Parameters<typeof combineCheckReports>[2] = source,
	toolchain: Parameters<typeof combineCheckReports>[3] = environment,
	shards: Partial<Record<string, number>> = {},
): Array<Parameters<typeof combineCheckReports>[0][number]> {
	return ["quality", "native", "sanitizer", "standards"].flatMap((lane) => {
		const count = shards[lane];
		const parts =
			count === undefined
				? [{ shard: null, stages: plan.stages.filter((stage) => stage.lane === lane) }]
				: Array.from({ length: count }, (_, index) => {
						const shard = { index: index + 1, count };
						return { shard, stages: shardPlan(lane, shard) };
					});
		return parts.map(({ shard, stages }) => {
			const selection = stages.map(({ name, invocation, lane }) => ({
				name,
				invocation,
				lane,
			}));
			return {
				schemaVersion: 4,
				runId: shard === null ? lane : `${lane}-${shard.index}`,
				tier: "check",
				lane,
				shard,
				complete: true,
				passed: true,
				startedAt: new Date().toISOString(),
				source: { before: { ...identity }, after: { ...identity }, consistent: true },
				environment: structuredClone(toolchain),
				selection,
				stages: selection.map(({ name, invocation }) => ({
					name,
					invocation,
					status: 0,
					signal: null,
				})),
			};
		});
	});
}

describe("CI check coverage aggregation", () => {
	it("reads downloaded artifacts through the CLI and retains a report only for complete coverage", () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), "maligator-ci-reports-"));
		try {
			for (const entry of ["scripts", "src", "runtime", "tests"]) {
				symlinkSync(path.join(root, entry), path.join(directory, entry));
			}
			writeFileSync(path.join(directory, ".gitignore"), ".cache/\n");
			execFileSync("git", ["init", "--quiet"], { cwd: directory });
			const tools = path.join(directory, "tools");
			mkdirSync(tools);
			for (const [name, version] of [
				["cc", "Clang fixture"],
				["rustc", "rustc fixture"],
			] as const) {
				writeFileSync(
					path.join(tools, name),
					`#!/bin/sh\nprintf '%s\\n' '${version}'\n`,
					{ mode: 0o755 },
				);
			}
			vi.stubEnv("CC", path.join(tools, "cc"));
			vi.stubEnv("PATH", `${tools}${path.delimiter}${process.env.PATH ?? ""}`);
			const identity = captureVerificationSource(directory);
			const toolchain = captureVerificationEnvironment(directory);
			const artifacts = path.join(directory, ".cache/ci-lane-reports");
			for (const report of reports(identity, toolchain, { native: 2, sanitizer: 3 })) {
				const lane = path.join(
					artifacts,
					`linux-${report.runId}-reports-123-1`,
					"test-suite/runs",
					report.runId,
				);
				mkdirSync(lane, { recursive: true });
				writeFileSync(path.join(lane, "report.json"), JSON.stringify(report));
			}
			const run = () =>
				spawnSync(
					process.execPath,
					[
						// Preserve the fixture root so simulated reports cannot become real evidence.
						"--preserve-symlinks-main",
						path.join(directory, "scripts/test-suite-ci.ts"),
						artifacts,
					],
					{ cwd: directory, encoding: "utf8" },
				);
			const success = run();
			expect(success.error).toBeUndefined();
			expect(success.status, success.stderr).toBe(0);
			const reportRoot = path.join(directory, ".cache/mal-build/test-suite");
			const latest = readFileSync(path.join(reportRoot, "report-check.json"), "utf8");
			const combined = JSON.parse(latest) as { runId: string; reportPath: string };
			expect(success.stdout).toContain(path.join(directory, combined.reportPath));
			expect(
				readFileSync(
					path.join(reportRoot, "runs", combined.runId, "report.json"),
					"utf8",
				),
			).toBe(latest);
			rmSync(path.join(artifacts, "linux-quality-reports-123-1"), { recursive: true });
			const incomplete = run();
			expect(incomplete.error).toBeUndefined();
			expect(incomplete.status).not.toBe(0);
			expect(incomplete.stderr).toContain("missing check coverage");
			expect(readFileSync(path.join(reportRoot, "report-check.json"), "utf8")).toBe(
				latest,
			);
			expect(readdirSync(path.join(reportRoot, "runs"))).toEqual([combined.runId]);
		} finally {
			vi.unstubAllEnvs();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("combines all canonical stages in plan order", () => {
		const combined = combineCheckReports(reports(), plan, source, environment);
		expect(combined.scope.coversEntireTier).toBe(true);
		expect(combined.stages.map((stage) => stage.invocation)).toEqual(
			plan.stages.map((stage) => stage.invocation),
		);
	});

	it("rejects missing and duplicate lanes", () => {
		const all = reports();
		expect(() => combineCheckReports(all.slice(1), plan, source, environment)).toThrow(
			"missing check coverage",
		);
		expect(() =>
			combineCheckReports([...all, all[0]!], plan, source, environment),
		).toThrow("duplicate lane");
	});

	it.each(["complete", "passed"] as const)(
		"rejects a report whose %s verdict is false",
		(field) => {
			const all = reports();
			all[0]![field] = false;
			expect(() => combineCheckReports(all, plan, source, environment)).toThrow(
				"failed or incomplete",
			);
		},
	);

	it("rejects source changes and mismatched toolchains", () => {
		const changed = reports();
		changed[0]!.source.after!.digest = "b".repeat(64);
		expect(() => combineCheckReports(changed, plan, source, environment)).toThrow(
			"source or environment mismatch",
		);
		const different = reports();
		different[0]!.environment.cc.version = "another compiler";
		expect(() => combineCheckReports(different, plan, source, environment)).toThrow(
			"source or environment mismatch",
		);
	});

	it("rejects missing toolchain identity even when every report matches", () => {
		const missing = { ...environment, cc: { ...environment.cc, version: "" } };
		expect(() =>
			combineCheckReports(reports(source, missing), plan, source, missing),
		).toThrow("missing verification toolchain identity");
	});

	it("rejects failed execution even when the report claims success", () => {
		const all = reports();
		all[0]!.stages[0]!.status = 1;
		expect(() => combineCheckReports(all, plan, source, environment)).toThrow(
			"failed, duplicate or unexpected stage",
		);
	});

	it("combines complete shard sets into the canonical stages", () => {
		const combined = combineCheckReports(
			reports(source, environment, { native: 2, sanitizer: 3 }),
			plan,
			source,
			environment,
			shardPlan,
		);
		expect(combined.stages.map((stage) => stage.invocation)).toEqual(
			plan.stages.map((stage) => stage.invocation),
		);
		const sanitizer = combined.stages.find(
			(stage) => stage.name === "check: native sanitizer-primary",
		);
		expect(sanitizer?.shards).toHaveLength(3);
	});

	it("rejects a lane missing one of its shards", () => {
		const all = reports(source, environment, { sanitizer: 3 }).filter(
			(report) => report.runId !== "sanitizer-2",
		);
		expect(() => combineCheckReports(all, plan, source, environment, shardPlan)).toThrow(
			"incomplete shard set",
		);
	});

	it("rejects duplicate shards and lanes that mix sharded and unsharded reports", () => {
		const sharded = reports(source, environment, { sanitizer: 3 });
		const duplicate = sharded.find((report) => report.runId === "sanitizer-1")!;
		expect(() =>
			combineCheckReports([...sharded, duplicate], plan, source, environment, shardPlan),
		).toThrow("duplicate or inconsistent shard");
		const whole = reports().find((report) => report.lane === "sanitizer")!;
		expect(() =>
			combineCheckReports([...sharded, whole], plan, source, environment, shardPlan),
		).toThrow("lane mixes sharded and unsharded reports");
	});

	it("rejects a shard whose selection differs from the planner's", () => {
		const all = reports(source, environment, { native: 2 });
		const shard = all.find((report) => report.runId === "native-1")!;
		shard.selection[0]!.invocation = `${shard.selection[0]!.invocation} tests/extra.test.ts`;
		expect(() => combineCheckReports(all, plan, source, environment, shardPlan)).toThrow(
			"selection mismatch",
		);
	});

	it("rejects an invocation that substitutes different coverage", () => {
		const all = reports();
		all[0]!.selection[0]!.invocation = "npm run different-test";
		expect(() => combineCheckReports(all, plan, source, environment)).toThrow(
			"selection mismatch",
		);
	});
});
