import { expect, test } from "vitest";
import { classifyMetricSamples, lanesForChangedFiles } from "../scripts/bench-compare.ts";

test("changed source files select transparent benchmark lanes", () => {
	const lanes = ["javascript", "http", "self-compile"];
	expect(lanesForChangedFiles(["runtime/src/builtin_string.c"], lanes)).toEqual([
		"javascript",
		"http",
	]);
	expect(lanesForChangedFiles(["src/compiler/core/optimize.ts"], lanes)).toEqual([
		"javascript",
		"http",
		"self-compile",
	]);
	expect(lanesForChangedFiles(["README.md"], lanes)).toEqual([]);
});

test("paired comparison fails a clear slowdown and accepts a sub-threshold change", () => {
	const slowdown = Array.from({ length: 7 }, (_, index) => ({
		base: 100 + index * 0.1,
		head: 110 + index * 0.1,
	}));
	const small = Array.from({ length: 7 }, (_, index) => ({
		base: 100 + index * 0.1,
		head: 101 + index * 0.1,
	}));
	expect(
		classifyMetricSamples("javascript.modes.closed-compiled.wallMs", slowdown)?.status,
	).toBe("regression");
	expect(
		classifyMetricSamples("javascript.modes.closed-compiled.wallMs", small)?.status,
	).toBe("unchanged");
});

test("paired comparison gives time and throughput ratios opposite directions", () => {
	const lower = Array.from({ length: 7 }, () => ({ base: 2, head: 1 }));
	const higher = Array.from({ length: 7 }, () => ({ base: 1, head: 2 }));
	expect(
		classifyMetricSamples("javascript.modes.closed-compiled.ratio", lower)?.status,
	).toBe("improvement");
	expect(classifyMetricSamples("http.bare.ratio", higher)?.status).toBe("improvement");
	expect(
		classifyMetricSamples("http.express.workloads.routes.ratio", higher)?.status,
	).toBe("improvement");
});

test("paired comparison retains a confident two percent wall improvement", () => {
	const improvement = Array.from({ length: 7 }, (_, index) => ({
		base: 100 + index * 0.01,
		head: 97.5 + index * 0.01,
	}));
	expect(
		classifyMetricSamples("javascript.modes.open-interpreted.phaseMs.text", improvement)
			?.status,
	).toBe("improvement");
});

test("the confidence interval must exclude zero, not the full threshold", () => {
	const improvements = [-1, -1.5, -2.5, -2.5, -2.5, -3, -3.5].map((change) => ({
		base: 100,
		head: 100 + change,
	}));
	const result = classifyMetricSamples(
		"javascript.modes.closed-compiled.wallMs",
		improvements,
	);
	expect(result?.medianRegressionPercent).toBeLessThan(-2);
	expect(result?.confidenceInterval[1]).toBeGreaterThan(-2);
	expect(result?.confidenceInterval[1]).toBeLessThan(0);
	expect(result?.status).toBe("improvement");
});

test("paired comparison treats exact A/A as unchanged and noisy evidence as inconclusive", () => {
	const equal = Array.from({ length: 5 }, () => ({ base: 100, head: 100 }));
	const noisy = [
		{ base: 100, head: 90 },
		{ base: 100, head: 110 },
		{ base: 100, head: 91 },
		{ base: 100, head: 109 },
		{ base: 100, head: 100 },
	];
	expect(
		classifyMetricSamples("javascript.modes.closed-compiled.wallMs", equal)?.status,
	).toBe("unchanged");
	expect(
		classifyMetricSamples("javascript.modes.closed-compiled.wallMs", noisy)?.status,
	).toBe("inconclusive");
});

test("binary size requires both percentage and practical byte movement", () => {
	const samples = Array.from({ length: 7 }, () => ({
		base: 1_000_000,
		head: 1_010_000,
	}));
	expect(
		classifyMetricSamples("javascript.modes.closed-compiled.binaryBytes", samples)
			?.status,
	).toBe("unchanged");
});

test("paired comparison ignores reference-engine timing noise", () => {
	const samples = Array.from({ length: 7 }, () => ({ base: 100, head: 200 }));
	expect(classifyMetricSamples("javascript.node.wallMs", samples)).toBeUndefined();
	expect(classifyMetricSamples("http.bare.nodeP99Ms", samples)).toBeUndefined();
});
