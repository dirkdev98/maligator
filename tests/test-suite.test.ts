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
		expect(check).toContain("smoke: Test262 cross-section");
		expect(check).toContain("check: native complement");
		expect(check).not.toContain("full: self-hosted frontend");
		expect(full).toContain("smoke: Test262 cross-section");
		expect(full).toContain("check: native complement");
		expect(full).toContain("full: self-hosted frontend");
		expect(full).toContain("full: Test262 interpreted GC verification");
		expect(smoke).toContain("  npm run type-check\n");
	});

	it("advertises approval boundaries and focused lanes", () => {
		const help = runSuite("--help");

		expect(help).toContain("npm run test:full           exhaustive fail-fast gate");
		expect(help).toContain("npm run test262:report      full Test262 report");
		expect(help).toContain("approval required");
		expect(help).toContain("npm run test262:regressions");
		expect(help).toContain("npm run test:check -- --list");
	});
});
