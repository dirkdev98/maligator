import type { Numbers } from "./types.ts";

export function describeValues(label: string, values: Numbers): string {
	return `${label}:${values.join(",")}:${values.map(double).join(",")}`;
}

function double(value: number): number {
	return value * 2;
}
