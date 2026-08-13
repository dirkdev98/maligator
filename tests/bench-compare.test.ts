import { expect, test } from "vitest";
import { classifyMetricSamples, lanesForChangedFiles } from "../scripts/bench-compare.ts";

test("changed source files select transparent benchmark lanes", () => {
	const lanes = ["compiler", "language", "string", "promise", "gc", "http"];
	expect(lanesForChangedFiles(["runtime/src/builtin_string.c"], lanes)).toEqual([
		"language",
		"string",
		"http",
	]);
	expect(lanesForChangedFiles(["src/ir-opt.ts"], lanes)).toEqual([
		"compiler",
		"language",
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
	expect(classifyMetricSamples("language.malMs", slowdown)?.status).toBe("regression");
	expect(classifyMetricSamples("language.malMs", small)?.status).toBe("unchanged");
});

test("paired comparison gives time and throughput ratios opposite directions", () => {
	const lower = Array.from({ length: 7 }, () => ({ base: 2, head: 1 }));
	const higher = Array.from({ length: 7 }, () => ({ base: 1, head: 2 }));
	expect(classifyMetricSamples("language.ratio", lower)?.status).toBe("improvement");
	expect(classifyMetricSamples("prototypeCache.runtimeRatio", lower)?.status).toBe(
		"improvement",
	);
	expect(classifyMetricSamples("http.ratio", higher)?.status).toBe("improvement");
	expect(classifyMetricSamples("http.express.middleware.ratio", higher)?.status).toBe(
		"improvement",
	);
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
	expect(classifyMetricSamples("language.malMs", equal)?.status).toBe("unchanged");
	expect(classifyMetricSamples("language.malMs", noisy)?.status).toBe("inconclusive");
});

test("binary size requires both percentage and practical byte movement", () => {
	const samples = Array.from({ length: 7 }, () => ({
		base: 1_000_000,
		head: 1_010_000,
	}));
	expect(classifyMetricSamples("size.full.binaryBytes", samples)?.status).toBe(
		"unchanged",
	);
});
