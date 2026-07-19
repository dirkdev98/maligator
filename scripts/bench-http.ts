export interface OhaMetrics {
	rps: number;
	p99Ms: number;
}

export interface ExpressHttpWorkload {
	name: "routes" | "json" | "form";
	durationSeconds: number;
	paths: Array<string>;
	method?: "POST";
	headers?: Array<string>;
	body?: string;
}

export function formatOhaDuration(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds <= 0) {
		throw new Error(`HTTP benchmark duration must be positive, got ${seconds}`);
	}
	return `${Math.max(1, Math.round(seconds * 1000))}ms`;
}

const EXPRESS_ROUTE_MIX = [
	"/users/a%20b?search=teeth&tag=one&tag=two",
	"/middleware",
	"/cookie",
	"/redirect-target",
	"/missing",
	"/async-error",
];

/** Split one practical measurement budget across the representative fixture surface. */
export function planExpressHttpWorkload(
	totalSeconds: number,
): Array<ExpressHttpWorkload> {
	if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
		throw new Error(`HTTP benchmark duration must be positive, got ${totalSeconds}`);
	}
	return [
		{
			name: "routes",
			durationSeconds: totalSeconds * 0.6,
			paths: EXPRESS_ROUTE_MIX,
		},
		{
			name: "json",
			durationSeconds: totalSeconds * 0.2,
			paths: ["/json"],
			method: "POST",
			headers: ["content-type: application/json"],
			body: JSON.stringify({ enabled: true, count: 2 }),
		},
		{
			name: "form",
			durationSeconds: totalSeconds * 0.2,
			paths: ["/form"],
			method: "POST",
			headers: ["content-type: application/x-www-form-urlencoded"],
			body: "name=Maligator&role=runtime",
		},
	];
}

export function parseOhaOutput(output: string): OhaMetrics {
	const parsed = JSON.parse(output) as {
		summary?: { requestsPerSec?: unknown };
		latencyPercentiles?: { p99?: unknown };
	};
	const rps = parsed.summary?.requestsPerSec;
	const p99Seconds = parsed.latencyPercentiles?.p99;
	if (
		typeof rps !== "number" ||
		!Number.isFinite(rps) ||
		rps < 0 ||
		typeof p99Seconds !== "number" ||
		!Number.isFinite(p99Seconds) ||
		p99Seconds < 0
	) {
		throw new Error("oha JSON did not contain finite requestsPerSec and p99 metrics");
	}
	return { rps, p99Ms: p99Seconds * 1000 };
}
