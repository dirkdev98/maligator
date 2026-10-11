import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = path.resolve(import.meta.dirname, "..");

function runSuite(...args: Array<string>): string {
	return execFileSync(process.execPath, ["scripts/test-suite.ts", ...args], {
		cwd: root,
		encoding: "utf8",
	});
}

function stageInvocation(output: string, stage: string): string {
	const lines = output.split("\n");
	const index = lines.findIndex((line) => line === `${stage}:`);
	if (index < 0) throw new Error(`missing stage ${stage}`);
	return lines[index + 1] ?? "";
}

function simulateSuiteStages(
	stages: Array<{ durationMs: number; status: number }>,
	policy: "bail" | "complete" = "bail",
	options: {
		runs?: number;
		lane?: string;
		changeSource?: boolean;
		nativeRemainder?: boolean;
	} = {},
) {
	const directory = mkdtempSync(path.join(os.tmpdir(), "maligator-smoke-budget-"));
	try {
		for (const entry of ["scripts", "src", "runtime", "tests", "package-lock.json"]) {
			symlinkSync(path.join(root, entry), path.join(directory, entry));
		}
		writeFileSync(path.join(directory, ".gitignore"), ".cache/\ncache/\n");
		writeFileSync(path.join(directory, "input.ts"), "export const value = 1;\n");
		execFileSync("git", ["init", "--quiet"], { cwd: directory });
		const run = () =>
			spawnSync(
				process.execPath,
				[
					// Keep the gate's report root inside this disposable fixture.
					"--preserve-symlinks-main",
					"--import",
					path.join(root, "tests/fixtures/test-suite-clock.mts"),
					path.join(directory, "scripts/test-suite.ts"),
					options.nativeRemainder ? "full" : "smoke",
					"--workers",
					"4",
					"--policy",
					policy,
					...(options.lane === undefined ? [] : ["--lane", options.lane]),
					...(options.nativeRemainder ? ["--native-remainder"] : []),
				],
				{
					cwd: directory,
					encoding: "utf8",
					env: {
						...process.env,
						MALIGATOR_CACHE_DIR: path.join(directory, "cache"),
						MAL_TEST_SUITE_FAKE_STAGES: JSON.stringify(stages),
						MAL_TEST_SUITE_SOURCE_CHANGE: options.changeSource ? "1" : "0",
					},
				},
			);
		let result = run();
		for (let index = 1; index < (options.runs ?? 1); index++) result = run();
		if (result.error !== undefined) throw result.error;
		const report = JSON.parse(
			readFileSync(
				path.join(
					directory,
					`.cache/mal-build/test-suite/report-${options.nativeRemainder ? "full-native-remainder" : "smoke"}${options.lane === undefined ? "" : `-${options.lane}`}.json`,
				),
				"utf8",
			),
		) as {
			runId: string;
			complete: boolean;
			passed: boolean;
			source: { consistent: boolean | null };
			scope: { coversEntireTier: boolean };
			stages: Array<{ name: string; status: number }>;
		};
		const retained = readdirSync(
			path.join(directory, ".cache/mal-build/test-suite/runs"),
		).map(
			(id) =>
				JSON.parse(
					readFileSync(
						path.join(directory, ".cache/mal-build/test-suite/runs", id, "report.json"),
						"utf8",
					),
				) as typeof report,
		);
		return {
			status: result.status,
			stderr: result.stderr,
			report,
			retained,
			fullSmokeStamp: existsSync(path.join(directory, "cache/v1/test-suite-smoke.json")),
		};
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

describe("test suite planner", () => {
	it("validates and lists every cumulative tier without executing it", () => {
		const smoke = runSuite("smoke", "--list");
		const check = runSuite("check", "--list");
		const full = runSuite("full", "--list");

		expect(smoke).toContain("smoke: Test262 cross-section");
		expect(smoke).not.toContain("check: native normal");
		expect(smoke).not.toContain("check: native sanitizer-primary");
		expect(smoke).toContain("tests/native/development-runner.test.ts");
		expect(smoke).not.toContain("tests/native/drivers.test.ts");
		expect(smoke).not.toContain("tests/assets.test.ts");
		expect(check).toContain("smoke: Test262 cross-section");
		expect(check).toContain("check: unit complement");
		expect(check).toContain("tests/assets.test.ts");
		expect(check).toContain("tests/native/drivers.test.ts");
		expect(check).toContain("check: native normal");
		expect(check).toContain("check: native sanitizer-primary");
		expect(check).toMatch(
			/check: native normal:[\s\S]*npm run test:native[\s\S]*tests\/native\/allocation-sinking\.test\.ts/,
		);
		expect(check).toMatch(
			/check: native sanitizer-primary:[\s\S]*npm run test:sanitize[\s\S]*tests\/native\/runtime-mechanics\.test\.ts/,
		);
		for (const compilerMatrix of [
			"tests/native/static-data-query.test.ts",
			"tests/native/static-primitive-operations.test.ts",
		]) {
			expect(stageInvocation(check, "check: native normal")).toContain(compilerMatrix);
			expect(stageInvocation(check, "check: native sanitizer-primary")).not.toContain(
				compilerMatrix,
			);
		}
		expect(check).not.toContain("full: self-hosted frontend");
		expect(full).toContain("smoke: Test262 cross-section");
		expect(full).toContain("check: native normal");
		expect(full).toContain("check: native sanitizer-primary");
		expect(full).toContain("full: self-hosted frontend");
		expect(full).toContain("npm run test:unit:full-only");
		expect(full).toContain("tests/toolchain.test.ts");
		expect(full).toContain("full: Test262 compiled normal corpus");
		expect(full).toContain("full: Test262 GC high-risk spine");
		expect(full).toContain("tests/test-suite-test262-gc.txt --variant strict");
		expect(full).toContain("full: Test262 GC sloppy-risk spine");
		expect(full).toContain("tests/test-suite-test262-gc-sloppy.txt --variant sloppy");
		expect(full).not.toMatch(
			/full: Test262 GC high-risk spine:[\s\S]*tests\/test-suite-test262-check\.txt/,
		);
		expect(full).toContain("full: WPT compiled normal");
		expect(full).toContain("full: WPT focused GC verification");
		expect(full).toContain("full: remaining: native normal");
		expect(full).toContain("full: remaining: native sanitizer-primary");
		expect(stageInvocation(full, "full: remaining: native normal")).toContain(
			"tests/native/shadow-realm.test.ts",
		);
		expect(stageInvocation(full, "full: remaining: native normal")).toContain(
			"tests/native/intl-features.test.ts",
		);
		for (const profile of [
			"tests/native/symbol-metadata-profiles.test.ts",
			"tests/native/string-raw-profiles.test.ts",
			"tests/native/string-call-profiles.test.ts",
		]) {
			expect(check).not.toContain(profile);
			expect(stageInvocation(full, "full: remaining: native normal")).toContain(profile);
			expect(
				stageInvocation(full, "full: remaining: native sanitizer-primary"),
			).not.toContain(profile);
		}
		expect(
			stageInvocation(full, "full: remaining: native sanitizer-primary"),
		).not.toContain("tests/native/shadow-realm.test.ts");
		expect(stageInvocation(full, "full: remaining: native sanitizer-primary")).toContain(
			"tests/native/allocation-failure.test.ts",
		);
		expect(stageInvocation(full, "full: remaining: native sanitizer-primary")).toContain(
			"tests/native/async-generator-direct-promise.test.ts",
		);
		expect(full).not.toContain("full: sanitizer suite");
		expect(full).not.toContain("full: Test262 interpreted");
		expect(full).not.toContain("full: WPT interpreted");
		expect(full).not.toContain("full: WPT backend and GC matrix");
		expect(smoke).toContain(" npm run type-check\n");
		expect(smoke).not.toContain("tests/fixtures/maligator-test");
	});

	it("advertises approval boundaries and focused lanes", () => {
		const help = runSuite("--help");

		expect(help).toContain("npm run test:full           exhaustive fail-fast gate");
		expect(help).toContain("npm run test262:report      full Test262 report");
		expect(help).toContain("approval required");
		expect(help).toContain("npm run test262:regressions");
		expect(help).toContain("20-second warm / fifteen-minute cold fuse at four workers");
		expect(help).toContain("npm run test:check -- --list");
		expect(help).toContain("--plan=json");
	});

	it("publishes exact sandbox and CPU requirements without a global lock", () => {
		const check = JSON.parse(runSuite("check", "--plan=json")) as {
			approval: string;
			requirements: { capabilities: Record<string, boolean> };
			coordination: { performanceLock: boolean; deferWhenBusy: boolean };
			stages: Array<{ name: string; requirements: { cpu: string } }>;
		};
		const full = JSON.parse(runSuite("full", "--plan=json")) as {
			approval: string;
		};

		expect(check.approval).toBe("none");
		expect(check.requirements.capabilities.loopbackListen).toBe(true);
		expect(check.requirements.capabilities.userCacheWrite).toBe(true);
		expect(check.requirements.capabilities.npmCacheWrite).toBe(true);
		expect(check.requirements.capabilities.cargoCacheWrite).toBe(true);
		expect(check.coordination).toEqual({
			inspectCpuBeforeHeavyWork: true,
			deferWhenBusy: true,
			performanceLock: false,
		});
		expect(
			check.stages.find((stage) => stage.name === "smoke: TypeScript")?.requirements.cpu,
		).toBe("light");
		expect(full.approval).toBe("explicit");
	});

	it("partitions check into disjoint lanes with complete canonical coverage", () => {
		const workflow = parse(
			readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8"),
		) as {
			jobs: { "linux-lanes": { strategy: { matrix: { lane: Array<string> } } } };
		};
		const complete = JSON.parse(runSuite("check", "--plan=json")) as {
			stages: Array<{ name: string; invocation: string }>;
		};
		const selected = workflow.jobs["linux-lanes"].strategy.matrix.lane.flatMap((lane) => {
			const plan = JSON.parse(runSuite("check", "--lane", lane, "--plan=json")) as {
				scope: { coversEntireTier: boolean };
				stages: typeof complete.stages;
			};
			expect(plan.scope.coversEntireTier).toBe(false);
			return plan.stages;
		});
		expect(new Set(selected.map((stage) => stage.name)).size).toBe(selected.length);
		expect(selected.map((stage) => stage.invocation).sort()).toEqual(
			complete.stages.map((stage) => stage.invocation).sort(),
		);
	});

	it("selects the complete native remainder without repeating check or standards coverage", () => {
		const filesIn = (...args: Array<string>) => {
			const plan = JSON.parse(runSuite(...args, "--plan=json")) as {
				approval: string;
				scope: { coversEntireTier: boolean };
				stages: Array<{ kind: string; invocation: string }>;
			};
			return {
				plan,
				files: plan.stages.flatMap((stage) =>
					stage.kind === "native"
						? (stage.invocation.match(/tests\/native\/[^\s]+\.test\.ts/g) ?? [])
						: [],
				),
			};
		};
		const check = filesIn("check").files;
		const full = filesIn("full").files;
		const remaining = filesIn("full", "--native-remainder");
		expect(remaining.plan.approval).toBe("none");
		expect(remaining.plan.scope.coversEntireTier).toBe(false);
		expect(remaining.plan.stages.every((stage) => stage.kind === "native")).toBe(true);
		// test:leak selects its fixture inside package.json rather than in the invocation.
		const leak = process.platform === "darwin" ? ["tests/native/leak.test.ts"] : [];
		const selected = [...check, ...remaining.files];
		expect(new Set(selected).size).toBe(selected.length);
		expect(selected.sort()).toEqual(full.sort());
		const allNative = readdirSync(path.join(root, "tests/native"), {
			recursive: true,
			encoding: "utf8",
		})
			.filter((file) => file.endsWith(".test.ts") && file !== "leak.test.ts")
			.map((file) => `tests/native/${file}`);
		expect([...selected, ...leak].sort()).toEqual([...allNative, ...leak].sort());
	});

	it("retains a remainder verdict without warming smoke or claiming a full gate pass", () => {
		const result = simulateSuiteStages(
			Array.from({ length: process.platform === "darwin" ? 3 : 2 }, () => ({
				durationMs: 1,
				status: 0,
			})),
			"complete",
			{ nativeRemainder: true },
		);
		expect(result.status).toBe(0);
		expect(result.report.passed).toBe(true);
		expect(result.report.scope.coversEntireTier).toBe(false);
		expect(result.fullSmokeStamp).toBe(false);
	});

	it.each([
		["--lane", "unknown"],
		["--lane", "quality", "--lane", "native"],
		["--lane", "sanitizer"],
		["--native-remainder"],
	])("rejects invalid or empty smoke selections %j", (...args) => {
		expect(() => runSuite("smoke", ...args, "--plan=json")).toThrow();
	});

	it("retains prior reports when publishing a new latest report", () => {
		const result = simulateSuiteStages(
			Array.from({ length: 5 }, () => ({ durationMs: 1, status: 0 })),
			"bail",
			{ runs: 2 },
		);
		expect(result.retained).toHaveLength(2);
		expect(new Set(result.retained.map((report) => report.runId)).size).toBe(2);
		expect(result.retained.every((report) => report.complete && report.passed)).toBe(
			true,
		);
		expect(result.retained).toContainEqual(result.report);
	});

	it("rejects successful stages when their source changed during execution", () => {
		const result = simulateSuiteStages(
			Array.from({ length: 5 }, () => ({ durationMs: 1, status: 0 })),
			"bail",
			{ changeSource: true },
		);
		expect(result.status).toBe(1);
		expect(result.report.complete).toBe(true);
		expect(result.report.passed).toBe(false);
		expect(result.report.source.consistent).toBe(false);
		expect(result.stderr).toContain("source changed during verification");
	});

	it("does not warm the full smoke stamp after a partial lane", () => {
		const result = simulateSuiteStages(
			[
				{ durationMs: 1, status: 0 },
				{ durationMs: 1, status: 0 },
			],
			"bail",
			{ lane: "quality" },
		);
		expect(result.status).toBe(0);
		expect(result.report.passed).toBe(true);
		expect(result.fullSmokeStamp).toBe(false);
	});

	it.each([1, 2, 4])(
		"right-sizes test and build workers within a %i-worker budget",
		(workers) => {
			const plan = JSON.parse(
				runSuite("check", "--workers", String(workers), "--plan=json"),
			) as {
				workers: number;
				smokeBudget: { nominalWorkers: number; warmMs: number; coldMs: number };
				stages: Array<{
					name: string;
					kind: string;
					workers: {
						testWorkers: number;
						childBuildJobs: number;
						preparationBuildJobs: number;
					};
					environment: NodeJS.ProcessEnv;
				}>;
			};
			expect(plan.workers).toBe(Math.min(workers, os.availableParallelism()));
			expect(plan.smokeBudget).toEqual({
				nominalWorkers: 4,
				warmMs: Math.ceil((20_000 * 4) / Math.min(plan.workers, 4)),
				coldMs: Math.ceil((900_000 * 4) / Math.min(plan.workers, 4)),
			});
			for (const stage of plan.stages) {
				expect(stage.environment.MALIGATOR_WORKERS).toBe(String(plan.workers));
				expect(stage.environment.MAL_TEST_WORKERS).toBe(
					String(stage.workers.testWorkers),
				);
				expect(stage.environment.MAL_PREPARATION_BUILD_JOBS).toBe(String(plan.workers));
				expect(
					stage.workers.testWorkers * stage.workers.childBuildJobs,
				).toBeLessThanOrEqual(plan.workers);
				expect(stage.workers.preparationBuildJobs).toBe(plan.workers);
			}
			const native = plan.stages.find((stage) => stage.name === "check: native normal")!;
			const nativeTestWorkers = Math.max(1, Math.floor(plan.workers / 2));
			expect(native.workers).toEqual({
				testWorkers: nativeTestWorkers,
				childBuildJobs: Math.max(1, Math.floor(plan.workers / nativeTestWorkers)),
				preparationBuildJobs: plan.workers,
			});
			expect(native.environment.MAL_BUILD_JOBS).toBe(
				String(native.workers.childBuildJobs),
			);
			expect(native.environment.CARGO_BUILD_JOBS).toBe(
				String(native.workers.childBuildJobs),
			);
			expect(native.environment.MAL_SANITIZER_WORKERS).toBe(String(nativeTestWorkers));
			const smokeNative = plan.stages.find(
				(stage) => stage.name === "smoke: native normal",
			)!;
			expect(smokeNative.workers).toEqual({
				testWorkers: 1,
				childBuildJobs: plan.workers,
				preparationBuildJobs: plan.workers,
			});
			expect(smokeNative.environment.MAL_BUILD_JOBS).toBe(String(plan.workers));
			expect(smokeNative.environment.MAL_NATIVE_PREWARM).toBe("0");
			expect(native.environment.MAL_NATIVE_PREWARM).toBeUndefined();
		},
	);

	it("reaches WPT after successful cold builds consume ten minutes", () => {
		const result = simulateSuiteStages(
			[22_400, 13_800, 104_000, 460_100, 60_000].map((durationMs) => ({
				durationMs,
				status: 0,
			})),
		);
		expect(result.status).toBe(0);
		expect(result.report.complete).toBe(true);
		expect(result.report.stages.at(-1)?.name).toBe("smoke: WPT cross-section");
	});

	it("still stops before the next stage when the cold fuse expires", () => {
		const result = simulateSuiteStages([{ durationMs: 3_600_001, status: 0 }]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("smoke fuse expired before all stages started");
		expect(result.report.complete).toBe(false);
		expect(result.report.stages.map((stage) => stage.name)).toEqual([
			"smoke: TypeScript",
		]);
	});

	it("still bails on a failed stage before the cold fuse expires", () => {
		const result = simulateSuiteStages([{ durationMs: 1, status: 1 }]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("exited with status 1");
		expect(result.report.complete).toBe(false);
		expect(result.report.stages).toMatchObject([
			{ name: "smoke: TypeScript", status: 1 },
		]);
	});

	it("finishes coverage under complete policy while reporting a cold fuse failure", () => {
		const result = simulateSuiteStages(
			[3_600_001, 0, 0, 0, 0].map((durationMs) => ({ durationMs, status: 0 })),
			"complete",
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("smoke fuse exceeded");
		expect(result.report.complete).toBe(true);
		expect(result.report.stages.at(-1)?.name).toBe("smoke: WPT cross-section");
	});

	it.each(["0", "-1", "1.5", "many"])(
		"rejects --workers %s before execution",
		(workers) => {
			expect(() => runSuite("check", "--workers", workers, "--plan=json")).toThrow();
		},
	);

	it.each(["smoke", "check", "full"])(
		"omits only quality stages from the %s plan and records the missing coverage",
		(tier) => {
			const complete = JSON.parse(runSuite(tier, "--plan=json")) as {
				stages: Array<{ name: string; kind: string; invocation: string }>;
			};
			const selected = JSON.parse(runSuite(tier, "--exclude-quality", "--plan=json")) as {
				scope: { coversEntireTier: boolean; excludedStages: Array<string> };
				stages: typeof complete.stages;
			};
			expect(selected.stages).toEqual(
				complete.stages.filter((stage) => stage.kind !== "quality"),
			);
			expect(selected.scope.coversEntireTier).toBe(false);
			expect(selected.scope.excludedStages).toContain("smoke: TypeScript");
			expect(
				selected.stages.some((stage) =>
					/npm run (type-check|lint:ci)/.test(stage.invocation),
				),
			).toBe(false);
			expect(
				selected.stages.some((stage) => stage.invocation.includes("scripts/test262.ts")),
			).toBe(true);
		},
	);

	it("preserves explicit baselines in a full JSON plan captured through a pipe", () => {
		const baseline = path.resolve(".cache/explicit-test262-baseline.json");
		const plan = JSON.parse(
			runSuite("full", "--test262-baseline", baseline, "--plan=json"),
		) as {
			test262Baseline: string;
			stages: Array<{ invocation: string }>;
		};
		expect(plan.test262Baseline).toBe(baseline);
		const standards = plan.stages.filter((stage) =>
			stage.invocation.includes("scripts/test262.ts"),
		);
		expect(standards.length).toBeGreaterThan(1);
		for (const stage of standards)
			expect(stage.invocation).toContain(`--baseline ${baseline}`);
	});

	it("does not populate build caches while planning", () => {
		const parent = mkdtempSync(path.join(os.tmpdir(), "maligator-plan-"));
		try {
			const cache = path.join(parent, "cache");
			execFileSync(process.execPath, ["scripts/test-suite.ts", "check", "--plan=json"], {
				cwd: root,
				env: { ...process.env, MALIGATOR_CACHE_DIR: cache },
			});
			expect(existsSync(cache)).toBe(false);
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});

	it("keeps telemetry out of the printed invocation identity", () => {
		const smoke = runSuite("smoke", "--list");
		expect(smoke).not.toContain("MAL_TEST_TELEMETRY_DIR");
	});
});
