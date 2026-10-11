import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { combineCheckReports } from "../scripts/test-suite-ci.ts";

const root = path.resolve(import.meta.dirname, "..");
const plan = JSON.parse(
	execFileSync(
		process.execPath,
		["scripts/test-suite.ts", "check", "--workers", "4", "--plan=json"],
		{ cwd: root, encoding: "utf8" },
	),
) as Parameters<typeof combineCheckReports>[1];
const source = { revision: "1234", digest: "a".repeat(64), dirty: false, files: 1 };
const environment = {
	platform: process.platform,
	arch: process.arch,
	node: process.version,
	cc: { command: "cc", version: "Clang fixture" },
	rustc: { version: "rustc fixture", toolchain: null },
};

function reports(): Array<Parameters<typeof combineCheckReports>[0][number]> {
	return ["quality", "native", "sanitizer", "standards"].map((lane) => {
		const selection = plan.stages
			.filter((stage) => stage.lane === lane)
			.map(({ name, invocation, lane }) => ({ name, invocation, lane }));
		return {
			schemaVersion: 4,
			runId: lane,
			tier: "check",
			lane,
			complete: true,
			passed: true,
			startedAt: new Date().toISOString(),
			source: { before: { ...source }, after: { ...source }, consistent: true },
			environment: structuredClone(environment),
			selection,
			stages: selection.map(({ name, invocation }) => ({
				name,
				invocation,
				status: 0,
				signal: null,
			})),
		};
	});
}

describe("CI check coverage aggregation", () => {
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

	it("rejects failed execution even when the report claims success", () => {
		const all = reports();
		all[0]!.stages[0]!.status = 1;
		expect(() => combineCheckReports(all, plan, source, environment)).toThrow(
			"failed, duplicate or unexpected stage",
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
