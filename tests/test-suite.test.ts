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
		expect(check).not.toContain("full: self-hosted frontend");
		expect(full).toContain("smoke: Test262 cross-section");
		expect(full).toContain("check: native normal");
		expect(full).toContain("check: native sanitizer-primary");
		expect(full).toContain("full: self-hosted frontend");
		expect(full).toContain("npm run test:unit:full-only");
		expect(full).toContain("tests/toolchain.test.ts");
		expect(full).toContain("full: Test262 compiled normal corpus");
		expect(full).toContain("full: Test262 curated GC verification");
		expect(full).toContain("full: WPT compiled normal");
		expect(full).toContain("full: WPT focused GC verification");
		expect(full).toContain("full: remaining: native normal");
		expect(full).toContain("full: remaining: native sanitizer-primary");
		expect(full).not.toContain("full: sanitizer suite");
		expect(full).not.toContain("full: Test262 interpreted");
		expect(full).not.toContain("full: WPT interpreted");
		expect(full).not.toContain("full: WPT backend and GC matrix");
		expect(smoke).toContain("  npm run type-check\n");
		expect(smoke).not.toContain("tests/fixtures/maligator-test");
	});

	it("advertises approval boundaries and focused lanes", () => {
		const help = runSuite("--help");

		expect(help).toContain("npm run test:full           exhaustive fail-fast gate");
		expect(help).toContain("npm run test262:report      full Test262 report");
		expect(help).toContain("approval required");
		expect(help).toContain("npm run test262:regressions");
		expect(help).toContain("20-second warm / four-minute cold");
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
