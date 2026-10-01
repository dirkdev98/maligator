import { expect, test } from "vitest";
import {
	measureNativeMicroPair,
	nativeMicroCalibrationScale,
} from "../scripts/native-micro-compare.ts";
import type { KernelOutput } from "../scripts/runtime-gap.ts";

const reference: KernelOutput = {
	schema: 2,
	workload: "runtime-gap-case-v2",
	id: "pair-example",
	scale: 1,
	operations: 10,
	checksum: 42,
	elapsedMs: 2,
	measurementStartMs: 1,
	measurementEndMs: 3,
	warmupMs: [1],
};

test("interleaves repeated Node samples around alternating native pairs", async () => {
	const observed: Array<string> = [];
	const run = (host: "node" | "baseline" | "candidate") => {
		observed.push(host);
		return Promise.resolve({
			...reference,
			elapsedMs: host === "node" ? 1 : host === "baseline" ? 4 : 3,
		});
	};
	const first = await measureNativeMicroPair(0, reference, run);
	const second = await measureNativeMicroPair(1, reference, run);
	expect(observed).toEqual([
		"node",
		"baseline",
		"candidate",
		"candidate",
		"baseline",
		"node",
	]);
	for (const pair of [first, second]) {
		expect(pair.node.elapsedMs).toBe(1);
		expect(pair.baseline.elapsedMs).toBe(4);
		expect(pair.candidate.elapsedMs).toBe(3);
		expect(pair.reductionPercent).toBe(25);
	}
});

test("rejects an incorrect repeated Node sample before accepting a timing pair", async () => {
	await expect(
		measureNativeMicroPair(0, reference, (host) =>
			Promise.resolve({ ...reference, checksum: host === "node" ? 43 : 42 }),
		),
	).rejects.toThrow("kernel work differs");
});

test("native comparisons extend short samples even when Node already meets its target", () => {
	expect(nativeMicroCalibrationScale(100, 10, 5, 80, 300, 30_000)).toBe(60);
	expect(nativeMicroCalibrationScale(100, 5, 10, 80, 300, 30_000)).toBe(60);
});

test("calibration respects the slowest host and in-process warmup timeout allowance", () => {
	expect(nativeMicroCalibrationScale(1_000, 10, 5, 80, 300, 60_000)).toBe(25);
	expect(nativeMicroCalibrationScale(10, 10_000, 5, 80, 300, 60_000)).toBe(1);
});

test("native calibration preserves Node targets and bounds very fast kernels", () => {
	expect(nativeMicroCalibrationScale(1, 400, 400, 80, 300, 120_000)).toBe(80);
	expect(nativeMicroCalibrationScale(1, 0.1, 0.1, 80, 300, 30_000)).toBe(256);
	expect(nativeMicroCalibrationScale(100, 400, 400, 80, 300, 30_000)).toBe(1);
});
