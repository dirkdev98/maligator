import { execFileSync } from "node:child_process";
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
		expect(smoke).not.toContain("check: native complement");
		expect(smoke).toContain("tests/native/development-runner.test.ts");
		expect(smoke).not.toContain("tests/native/drivers.test.ts");
		expect(smoke).not.toContain("tests/assets.test.ts");
		expect(check).toContain("smoke: Test262 cross-section");
		expect(check).toContain("check: unit complement");
		expect(check).toContain("tests/assets.test.ts");
		expect(check).toContain("tests/native/drivers.test.ts");
		expect(check).toContain("check: native complement");
		expect(check).not.toContain("full: self-hosted frontend");
		expect(full).toContain("smoke: Test262 cross-section");
		expect(full).toContain("check: native complement");
		expect(full).toContain("full: self-hosted frontend");
		expect(full).toContain("full: Test262 interpreted GC verification");
		expect(full).toContain(
			"--exclude-manifest tests/test-suite-test262-smoke.txt --exclude-manifest tests/test-suite-test262-check.txt",
		);
		expect(full).toContain("full: WPT compiled GC verification");
		expect(full).toContain("full: WPT interpreted GC verification");
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
		expect(help).toContain("20-second warm / 60-second cold");
		expect(help).toContain("npm run test:check -- --list");
	});
});
