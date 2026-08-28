import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

export const TEST_TELEMETRY_ENV = "MAL_TEST_TELEMETRY_DIR";

export interface TestTelemetryEvent {
	schemaVersion: 1;
	pid: number;
	phase: string;
	label: string;
	startedAtMs: number;
	durationMs: number;
	cache?: "hit" | "miss";
	units?: number;
	config?: string;
}

/** Emit one completed native-test span when the enclosing gate requests telemetry. */
export function recordTestTelemetry(
	event: Omit<TestTelemetryEvent, "schemaVersion" | "pid">,
	environment: NodeJS.ProcessEnv = process.env,
): void {
	const directory = environment[TEST_TELEMETRY_ENV];
	if (directory === undefined || directory.length === 0) return;
	mkdirSync(directory, { recursive: true });
	// Each process owns its own file, so Vitest forks never contend on a writer.
	appendFileSync(
		path.join(directory, `${process.pid}.jsonl`),
		`${JSON.stringify({ schemaVersion: 1, pid: process.pid, ...event })}\n`,
	);
}

export function readTestTelemetry(directory: string): Array<TestTelemetryEvent> {
	let names: Array<string>;
	try {
		names = readdirSync(directory).filter((name) => name.endsWith(".jsonl"));
	} catch {
		return [];
	}
	const events: Array<TestTelemetryEvent> = [];
	for (const name of names.sort()) {
		for (const line of readFileSync(path.join(directory, name), "utf8").split("\n")) {
			if (line.length === 0) continue;
			try {
				const event = JSON.parse(line) as Partial<TestTelemetryEvent>;
				if (
					event.schemaVersion === 1 &&
					typeof event.pid === "number" &&
					typeof event.phase === "string" &&
					typeof event.label === "string" &&
					typeof event.startedAtMs === "number" &&
					typeof event.durationMs === "number"
				) {
					events.push(event as TestTelemetryEvent);
				}
			} catch {
				// A killed process can leave one incomplete final line. Earlier spans
				// remain diagnostic while the gate result still owns pass/fail.
			}
		}
	}
	return events.sort(
		(left, right) =>
			left.startedAtMs - right.startedAtMs ||
			left.pid - right.pid ||
			left.phase.localeCompare(right.phase),
	);
}

export interface TestTelemetrySummary {
	eventCount: number;
	processCount: number;
	phaseTotalsMs: Record<string, number>;
	cache: Record<string, { hit: number; miss: number }>;
	top: Array<Pick<TestTelemetryEvent, "phase" | "label" | "durationMs" | "cache">>;
}

export function summarizeTestTelemetry(
	events: ReadonlyArray<TestTelemetryEvent>,
): TestTelemetrySummary {
	const phaseTotalsMs: Record<string, number> = {};
	const cache: Record<string, { hit: number; miss: number }> = {};
	for (const event of events) {
		phaseTotalsMs[event.phase] = (phaseTotalsMs[event.phase] ?? 0) + event.durationMs;
		if (event.cache !== undefined) {
			cache[event.phase] ??= { hit: 0, miss: 0 };
			cache[event.phase]![event.cache]++;
		}
	}
	return {
		eventCount: events.length,
		processCount: new Set(events.map((event) => event.pid)).size,
		phaseTotalsMs: Object.fromEntries(
			Object.entries(phaseTotalsMs)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([phase, durationMs]) => [phase, Math.round(durationMs * 1000) / 1000]),
		),
		cache,
		top: [...events]
			.sort((left, right) => right.durationMs - left.durationMs)
			.slice(0, 20)
			.map(({ phase, label, durationMs, cache: cacheState }) => ({
				phase,
				label,
				durationMs: Math.round(durationMs * 1000) / 1000,
				...(cacheState === undefined ? {} : { cache: cacheState }),
			})),
	};
}
