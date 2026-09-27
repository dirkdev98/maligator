import { describe, expect, it } from "vitest";
import { processCpuDeltaMs } from "../scripts/bench-http-ordinary.ts";
import {
	formatOhaDuration,
	parseCheckedOhaOutput,
	parseOhaOutput,
	planExpressHttpWorkload,
} from "../scripts/bench-http.ts";

describe("HTTP benchmark support", () => {
	it("plans the representative Express workload within one duration budget", () => {
		const plan = planExpressHttpWorkload(10);
		expect(plan.map(({ name, durationSeconds }) => [name, durationSeconds])).toEqual([
			["routes", 6],
			["json", 2],
			["form", 2],
		]);
		expect(plan[0]?.paths).toEqual([
			"/users/a%20b?search=teeth&tag=one&tag=two",
			"/middleware",
			"/cookie",
			"/redirect-target",
			"/missing",
			"/async-error",
		]);
		expect(plan[1]).toMatchObject({
			method: "POST",
			headers: ["content-type: application/json"],
			body: '{"enabled":true,"count":2}',
		});
		expect(plan[2]).toMatchObject({
			method: "POST",
			headers: ["content-type: application/x-www-form-urlencoded"],
			body: "name=Maligator&role=runtime",
		});
	});

	it("parses oha throughput and converts p99 seconds to milliseconds", () => {
		expect(
			parseOhaOutput(
				JSON.stringify({
					summary: { requestsPerSec: 1234.5 },
					latencyPercentiles: { p99: 0.0125 },
				}),
			),
		).toEqual({ rps: 1234.5, p99Ms: 12.5 });
	});

	it("formats fractional workload durations without floating-point artifacts", () => {
		expect(formatOhaDuration(3 * 0.6)).toBe("1800ms");
		expect(formatOhaDuration(0.2)).toBe("200ms");
		expect(() => formatOhaDuration(0)).toThrow(/must be positive/);
	});

	it("rejects incomplete oha metrics instead of recording zeros", () => {
		expect(() => parseOhaOutput('{"summary":{"requestsPerSec":10}}')).toThrow(
			/requestsPerSec and p99/,
		);
	});

	it("rejects transport failures and unexpected status codes while allowing fixture errors", () => {
		const output = (
			statusCodeDistribution: Record<string, number>,
			errorDistribution: Record<string, number> = {},
		) =>
			JSON.stringify({
				summary: { requestsPerSec: 78, total: 2 },
				latencyPercentiles: { p99: 0.01 },
				statusCodeDistribution,
				errorDistribution,
			});
		expect(
			parseCheckedOhaOutput(
				output({ 200: 100, 302: 3, 404: 2, 500: 1 }, { "aborted due to deadline": 50 }),
				[200, 302, 404, 500],
			),
		).toEqual({
			rps: 78,
			p99Ms: 10,
			completedRequests: 106,
			completedRps: 53,
			abortedRequests: 50,
		});
		expect(() => parseCheckedOhaOutput(output({ 200: 10, 503: 1 }), [200])).toThrow(
			/unexpected statuses/,
		);
		expect(() => parseCheckedOhaOutput(output({ 200: 10 }), [200, 302])).toThrow(
			/unexpected statuses/,
		);
		expect(() => parseCheckedOhaOutput(output({ 200: NaN }), [200])).toThrow(
			/unexpected statuses/,
		);
		expect(() =>
			parseCheckedOhaOutput(output({ 200: 10 }, { "connection refused": 1 }), [200]),
		).toThrow(/transport errors/);
		expect(() =>
			parseCheckedOhaOutput(
				JSON.stringify({
					summary: { requestsPerSec: 10 },
					latencyPercentiles: { p99: 0.01 },
					statusCodeDistribution: { 200: 10 },
					errorDistribution: {},
				}),
				[200],
			),
		).toThrow(/elapsed duration/);
	});

	it("rejects a CPU delta from a replaced or regressed server process", () => {
		const before = { pid: 42, startTimeTicks: 100, cpuTicks: 500 };
		expect(processCpuDeltaMs(before, { ...before, cpuTicks: 550 }, 100)).toBe(500);
		expect(
			processCpuDeltaMs(before, { ...before, startTimeTicks: 101 }, 100),
		).toBeUndefined();
		expect(processCpuDeltaMs(before, { ...before, cpuTicks: 499 }, 100)).toBeUndefined();
	});
});
