import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	readTestTelemetry,
	recordTestTelemetry,
	summarizeTestTelemetry,
	TEST_TELEMETRY_ENV,
} from "../src/test-telemetry.ts";

describe("test telemetry", () => {
	it("records process-local spans and summarizes phases and cache outcomes", () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), "mal-test-telemetry-"));
		try {
			const environment = { [TEST_TELEMETRY_ENV]: directory };
			recordTestTelemetry(
				{
					phase: "frontend",
					label: "fixture-a.mjs",
					startedAtMs: 10,
					durationMs: 12.5,
					cache: "miss",
				},
				environment,
			);
			recordTestTelemetry(
				{
					phase: "frontend",
					label: "fixture-b.mjs",
					startedAtMs: 30,
					durationMs: 2,
					cache: "hit",
				},
				environment,
			);

			const events = readTestTelemetry(directory);
			expect(events).toHaveLength(2);
			expect(summarizeTestTelemetry(events)).toMatchObject({
				eventCount: 2,
				processCount: 1,
				phaseTotalsMs: { frontend: 14.5 },
				cache: { frontend: { hit: 1, miss: 1 } },
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("is inert unless a gate requests a telemetry directory", () => {
		expect(() =>
			recordTestTelemetry(
				{ phase: "execute", label: "unused", startedAtMs: 0, durationMs: 1 },
				{},
			),
		).not.toThrow();
	});
});
