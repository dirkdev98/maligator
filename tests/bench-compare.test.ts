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

test("paired comparison recognizes small consistent slowdowns", () => {
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
	).toBe("regression");
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

test("paired comparison retains confident sub-percent time and throughput gains", () => {
	const improvement = Array.from({ length: 7 }, (_, index) => ({
		base: 100 + index * 0.01,
		head: 99.5 + index * 0.01,
	}));
	const throughput = Array.from({ length: 7 }, (_, index) => ({
		base: 100 + index * 0.01,
		head: 100.5 + index * 0.01,
	}));
	expect(
		classifyMetricSamples("javascript.modes.open-interpreted.phaseMs.text", improvement)
			?.status,
	).toBe("improvement");
	expect(classifyMetricSamples("http.bare.malRps", throughput)?.status).toBe(
		"improvement",
	);
});

test("small improvements require an interval excluding zero", () => {
	const improvements = [-0.4, -0.6, -0.8, -0.9, -1.1, -1.2, -1.4].map((change) => ({
		base: 100,
		head: 100 + change,
	}));
	const result = classifyMetricSamples(
		"javascript.modes.closed-compiled.wallMs",
		improvements,
	);
	expect(result?.medianRegressionPercent).toBeGreaterThan(-2);
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
