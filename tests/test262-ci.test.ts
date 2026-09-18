import { describe, expect, it } from "vitest";
import { summarizeTest262Report } from "../scripts/test262-ci.ts";

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: 2,
		backend: "compiled",
		mode: "normal",
		policy: "complete",
		complete: true,
		selectedTests: 3,
		summary: { PASSED: 1, FAILED: 1, SKIPPED: 1 },
		regressions: ["test/language/regression.js"],
		improvements: ["test/language/improvement.js"],
		baseline: { commit: "0123456789abcdef", digest: "a".repeat(64) },
		...overrides,
	};
}

describe("Test262 CI summaries", () => {
	it("renders the authoritative run, totals, improvements, and escaped regressions", () => {
		const result = summarizeTest262Report(
			report({ regressions: ["test/<unexpected>.js"] }),
			"https://github.com/dirkdev98/maligator/actions/runs/1",
		);

		expect(result).toMatchObject({ regressions: 1, improvements: 1 });
		expect(result.body).toContain(
			"[GitHub Actions](https://github.com/dirkdev98/maligator/actions/runs/1)",
		);
		expect(result.body).toContain("Passed: 1");
		expect(result.body).toContain("Newly passing: 1");
		expect(result.body).toContain("<code>test/&lt;unexpected&gt;.js</code>");
	});

	it("caps issue details while retaining the complete regression count", () => {
		const regressions = Array.from({ length: 205 }, (_, index) => `test/${index}.js`);
		const result = summarizeTest262Report(
			report({ regressions }),
			"https://example.test/run",
		);

		expect(result.regressions).toBe(205);
		expect(result.body).toContain("Regressions (205)");
		expect(result.body).toContain("<code>test/199.js</code>");
		expect(result.body).not.toContain("<code>test/200.js</code>");
		expect(result.body).toContain("workflow artifact contains the complete report");
	});

	it("refuses incomplete or noncanonical reports", () => {
		expect(() =>
			summarizeTest262Report(report({ complete: false }), "https://example.test/run"),
		).toThrow("must be complete");
		expect(() =>
			summarizeTest262Report(report({ backend: "wire" }), "https://example.test/run"),
		).toThrow("compiled backend");
	});
});
