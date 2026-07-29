import { existsSync, readFileSync, writeFileSync } from "node:fs";

export function readBenchmarkBaseline<T extends object>(file: string): T | undefined {
	if (!existsSync(file)) return undefined;
	return JSON.parse(readFileSync(file, "utf8")) as T;
}

export function mergeBenchmarkBaseline<T extends object>(
	previous: T | undefined,
	current: Partial<T>,
): T {
	return { ...previous, ...current } as T;
}

/** Persist selected benchmark sections only when the CLI received `--update`. */
export function persistBenchmarkBaseline<T extends object>(
	file: string,
	previous: T | undefined,
	current: Partial<T>,
	update: boolean,
): T | undefined {
	if (!update) return previous;
	const merged = mergeBenchmarkBaseline(previous, current);
	writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
	return merged;
}
