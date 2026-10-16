import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const githubRoot = path.resolve(import.meta.dirname, "../.github");

function yamlFiles(directory: string): Array<string> {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const file = path.join(directory, entry.name);
		if (entry.isDirectory()) return yamlFiles(file);
		return /\.ya?ml$/.test(entry.name) ? [file] : [];
	});
}

function usedActions(value: unknown): Array<string> {
	if (Array.isArray(value)) return value.flatMap(usedActions);
	if (value === null || typeof value !== "object") return [];
	return Object.entries(value).flatMap(([key, child]) => [
		...(key === "uses" && typeof child === "string" ? [child] : []),
		...usedActions(child),
	]);
}

describe("GitHub Actions", () => {
	it("keeps scheduled native coverage separate and includes both platform dimensions", () => {
		const workflow = parse(
			readFileSync(path.join(githubRoot, "workflows/native-remainder.yml"), "utf8"),
		) as {
			on: { schedule: Array<{ cron: string }>; workflow_dispatch: unknown };
			permissions: Record<string, string>;
			jobs: {
				"native-remainder": {
					strategy: {
						matrix: {
							include: Array<{ os: string; lane: string; shard: number; shards: number }>;
						};
					};
					steps: Array<{ run?: string }>;
				};
			};
		};
		expect(workflow.on.schedule).toHaveLength(1);
		expect(workflow.on).toHaveProperty("workflow_dispatch");
		expect(workflow.permissions).toEqual({ contents: "read" });
		const job = workflow.jobs["native-remainder"];
		const dimensions = new Map<string, Array<number>>();
		for (const { os, lane, shard, shards } of job.strategy.matrix.include) {
			const key = `${os}/${lane}/${shards}`;
			dimensions.set(key, [...(dimensions.get(key) ?? []), shard]);
		}
		expect(
			[...dimensions.keys()].map((key) => key.split("/").slice(0, 2).join("/")).sort(),
		).toEqual([
			"macos-15/native",
			"macos-15/sanitizer",
			"ubuntu-24.04/native",
			"ubuntu-24.04/sanitizer",
		]);
		for (const [key, shards] of dimensions) {
			const count = Number(key.split("/")[2]);
			expect(shards.sort(), key).toEqual(
				Array.from({ length: count }, (_, index) => index + 1),
			);
		}
		expect(
			job.steps.some((step) => step.run?.startsWith("npm run test:native:remainder -- ")),
		).toBe(true);
		expect(job.steps.some((step) => /test262|test:full/.test(step.run ?? ""))).toBe(
			false,
		);
	});

	it("requires successful lane aggregation for the existing Linux check", () => {
		const workflow = parse(
			readFileSync(path.join(githubRoot, "workflows/ci.yml"), "utf8"),
		) as {
			jobs: Record<
				string,
				{
					name: string;
					needs?: string;
					if?: string;
					strategy?: { "fail-fast": boolean };
					steps: Array<{ run?: string; env?: Record<string, string> }>;
				}
			>;
		};
		const aggregate = workflow.jobs["linux-check"]!;
		expect(aggregate.name).toBe("Linux check");
		expect(aggregate.needs).toBe("linux-lanes");
		expect(aggregate.if).toBe("always()");
		expect(aggregate.steps[0]?.env?.LANE_RESULT).toBe("${{ needs.linux-lanes.result }}");
		expect(aggregate.steps[0]?.run).toBe('test "$LANE_RESULT" = success');
		expect(
			aggregate.steps.some(
				(step) => step.run === "node scripts/test-suite-ci.ts .cache/ci-lane-reports",
			),
		).toBe(true);
		expect(workflow.jobs["linux-lanes"]?.strategy?.["fail-fast"]).toBe(false);
	});

	it("splits the full-only unit manifest across Extended CI jobs without gaps", () => {
		const workflow = parse(
			readFileSync(path.join(githubRoot, "workflows/extended-ci.yml"), "utf8"),
		) as {
			jobs: {
				"slow-units": {
					strategy: { matrix: { include: Array<{ files?: string; exclude?: string }> } };
				};
			};
		};
		const manifest = readFileSync(
			path.join(githubRoot, "../tests/test-suite-unit-full-only.txt"),
			"utf8",
		)
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith("#"));
		const selected = workflow.jobs["slow-units"].strategy.matrix.include.flatMap(
			({ files, exclude }) =>
				files?.split(" ") ??
				manifest.filter((file) => exclude === undefined || !file.includes(exclude)),
		);
		expect(selected.sort()).toEqual([...manifest].sort());
	});

	it("does not use runner-local contexts in job-level environment expressions", () => {
		const violations: Array<string> = [];
		for (const file of yamlFiles(path.join(githubRoot, "workflows"))) {
			const workflow = parse(readFileSync(file, "utf8")) as {
				jobs?: Record<string, { env?: Record<string, unknown> }>;
			};
			for (const [job, configuration] of Object.entries(workflow.jobs ?? {})) {
				for (const [name, value] of Object.entries(configuration.env ?? {})) {
					if (
						typeof value === "string" &&
						/\$\{\{[^}]*\b(?:runner|steps|job|jobs|env)\./.test(value)
					)
						violations.push(
							`${path.relative(githubRoot, file)}: jobs.${job}.env.${name}`,
						);
				}
			}
		}
		expect(violations).toEqual([]);
	});

	it("selects the pinned Rust toolchain and prepares cacheable Test262 inputs", () => {
		for (const platform of ["linux", "macos"]) {
			const action = readFileSync(
				path.join(githubRoot, "actions", `setup-${platform}`, "action.yml"),
				"utf8",
			);
			expect(action).toContain('echo "RUSTUP_TOOLCHAIN=$toolchain" >> "$GITHUB_ENV"');
			expect(action).toContain("run: npm run test262:prepare");
		}
	});

	it("isolates macOS from the hosted image's Rustup installation", () => {
		const action = readFileSync(
			path.join(githubRoot, "actions/setup-macos/action.yml"),
			"utf8",
		);
		expect(action).toContain('case "$(uname -m)" in');
		expect(action).toContain("rustup_target=aarch64-apple-darwin");
		expect(action).toContain("rustup_target=x86_64-apple-darwin");
		expect(action).toContain("rustup/archive/1.29.0/$rustup_target/rustup-init");
		expect(action).toContain(
			"aeb4105778ca1bd3c6b0e75768f581c656633cd51368fa61289b6a71696ac7e1",
		);
		expect(action).toContain(
			"33cf85df9142bc6d29cbc62fa5ca1d4c29622cddb55213a4c1a43c457fb9b2d7",
		);
		expect(action).toContain('echo "RUSTUP_HOME=$rustup_home" >> "$GITHUB_ENV"');
	});

	it("keeps every external action dependency immutable", () => {
		const violations: Array<string> = [];
		for (const file of yamlFiles(githubRoot)) {
			const document = parse(readFileSync(file, "utf8")) as unknown;
			for (const action of usedActions(document)) {
				if (!action.startsWith("./") && !/^[^@]+@[0-9a-f]{40}$/.test(action)) {
					violations.push(`${path.relative(githubRoot, file)}: ${action}`);
				}
			}
		}
		expect(violations).toEqual([]);
	});

	it("does not execute pull request code in a privileged target workflow", () => {
		for (const file of yamlFiles(path.join(githubRoot, "workflows"))) {
			const workflow = parse(readFileSync(file, "utf8")) as Record<string, unknown>;
			expect(workflow.on).not.toHaveProperty("pull_request_target");
		}
	});
});
