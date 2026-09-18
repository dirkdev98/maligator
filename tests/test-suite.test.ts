import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

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
		expect(help).toContain("20-second warm / ten-minute cold fuse at four workers");
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
				coldMs: Math.ceil((600_000 * 4) / Math.min(plan.workers, 4)),
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

	it("passes an explicit comparison baseline to every Test262 stage in the full plan", () => {
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
