export interface V8GcTraceSummary {
	readonly source: "v8-trace-gc";
	readonly wallMs: number;
	readonly events: number;
	readonly maximumPauseMs: number;
}

export function summarizeV8GcTrace(
	stderr: string,
	lowerMs: number,
	upperMs: number,
): V8GcTraceSummary {
	let wallMs = 0;
	let events = 0;
	let maximumPauseMs = 0;
	for (const line of stderr.split("\n")) {
		const match = /^\[[^\]]+\]\s+([\d.]+) ms: GC: (\{.*\})$/.exec(line);
		if (match === null) continue;
		const timestamp = Number(match[1]);
		if (timestamp < lowerMs || timestamp > upperMs) continue;
		let event: { readonly pause?: unknown };
		try {
			event = JSON.parse(match[2]!) as { readonly pause?: unknown };
		} catch {
			continue;
		}
		if (typeof event.pause !== "number" || !Number.isFinite(event.pause)) continue;
		wallMs += event.pause;
		events++;
		maximumPauseMs = Math.max(maximumPauseMs, event.pause);
	}
	return Object.freeze({
		source: "v8-trace-gc",
		wallMs,
		events,
		maximumPauseMs,
	});
}

export function parseExternalPeakRss(
	stderr: string,
	platform: NodeJS.Platform,
): number | undefined {
	if (platform === "darwin") {
		const match = /^\s*(\d+)\s+maximum resident set size\s*$/m.exec(stderr);
		return match === null ? undefined : Number(match[1]);
	}
	const match = /^\s*Maximum resident set size \(kbytes\):\s*(\d+)\s*$/m.exec(stderr);
	return match === null ? undefined : Number(match[1]) * 1_024;
}
