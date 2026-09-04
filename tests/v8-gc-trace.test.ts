import { describe, expect, test } from "vitest";
import { parseExternalPeakRss, summarizeV8GcTrace } from "../scripts/v8-gc-trace.ts";

describe("V8 GC trace summary", () => {
	test("attributes pause time only inside the compiler phase", () => {
		const stderr = [
			'[1:0:0] 90 ms: GC: {"pause":2,"gc":"s"}',
			'[1:0:0] 110 ms: GC: {"pause":3.25,"gc":"s"}',
			'[1:0:0] 150 ms: GC: {"pause":8.5,"gc":"mc"}',
			'[1:0:0] 210 ms: GC: {"pause":13,"gc":"s"}',
		].join("\n");

		expect(summarizeV8GcTrace(stderr, 100, 200)).toEqual({
			source: "v8-trace-gc",
			wallMs: 11.75,
			events: 2,
			maximumPauseMs: 8.5,
		});
	});

	test("ignores malformed trace records", () => {
		const stderr = [
			"[1:0:0] 110 ms: GC: not-json",
			'[1:0:0] 120 ms: GC: {"pause":"slow"}',
		].join("\n");

		expect(summarizeV8GcTrace(stderr, 100, 200).events).toBe(0);
	});
});

describe("external peak RSS", () => {
	test("reads macOS byte output", () => {
		expect(
			parseExternalPeakRss("  2145386496  maximum resident set size\n", "darwin"),
		).toBe(2_145_386_496);
	});

	test("converts GNU time kilobytes to bytes", () => {
		expect(
			parseExternalPeakRss("Maximum resident set size (kbytes): 2095104\n", "linux"),
		).toBe(2_145_386_496);
	});
});
