import { expect, test } from "vitest";
import { nativeMicroCalibrationScale } from "../scripts/native-micro-compare.ts";

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
