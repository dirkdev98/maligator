export interface OhaMetrics {
	rps: number;
	p99Ms: number;
}

export interface CheckedOhaMetrics extends OhaMetrics {
	completedRequests: number;
	completedRps: number;
	abortedRequests: number;
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

export function parseCheckedOhaOutput(
	output: string,
	expectedStatuses: ReadonlyArray<number>,
): CheckedOhaMetrics {
	const parsed = JSON.parse(output) as {
		summary?: { total?: number };
		statusCodeDistribution?: Record<string, number>;
		errorDistribution?: Record<string, number>;
	};
	const statuses = Object.entries(parsed.statusCodeDistribution ?? {});
	if (
		statuses.length === 0 ||
		statuses.some(
			([status, count]) =>
				!expectedStatuses.includes(Number(status)) ||
				!Number.isSafeInteger(count) ||
				count <= 0,
		) ||
		expectedStatuses.some(
			(status) => !statuses.some(([observed]) => Number(observed) === status),
		)
	) {
		throw new Error(
			`oha returned unexpected statuses: ${JSON.stringify(parsed.statusCodeDistribution)}`,
		);
	}
	if (
		parsed.errorDistribution === undefined ||
		Object.entries(parsed.errorDistribution).some(
			([reason, count]) =>
				reason !== "aborted due to deadline" ||
				!Number.isSafeInteger(count) ||
				count < 0 ||
				count > 50,
		)
	) {
		throw new Error(`oha transport errors: ${JSON.stringify(parsed.errorDistribution)}`);
	}
	const metrics = parseOhaOutput(output);
	const elapsedSeconds = parsed.summary?.total;
	const completedRequests = statuses.reduce((sum, [, count]) => sum + count, 0);
	const abortedRequests = Object.values(parsed.errorDistribution).reduce(
		(sum, count) => sum + count,
		0,
	);
	if (
		metrics.rps <= 0 ||
		!Number.isFinite(elapsedSeconds) ||
		elapsedSeconds === undefined ||
		elapsedSeconds <= 0 ||
		!Number.isSafeInteger(completedRequests) ||
		completedRequests <= 0
	)
		throw new Error("oha reported no completed requests or elapsed duration");
	return {
		...metrics,
		completedRequests,
		completedRps: completedRequests / elapsedSeconds,
		abortedRequests,
	};
}
