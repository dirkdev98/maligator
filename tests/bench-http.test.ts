import { describe, expect, it } from "vitest";
import { parseOhaOutput, planExpressHttpWorkload } from "../scripts/bench-http.ts";

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

	it("rejects incomplete oha metrics instead of recording zeros", () => {
		expect(() => parseOhaOutput('{"summary":{"requestsPerSec":10}}')).toThrow(
			/requestsPerSec and p99/,
		);
	});
});
