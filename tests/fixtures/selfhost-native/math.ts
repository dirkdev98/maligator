export function fibonacci(value: number): number {
	let previous: number = 0;
	let current: number = 1;
	for (let index: number = 0; index < value; index++) {
		const next: number = previous + current;
		previous = current;
		current = next;
	}
	return previous;
}

export function total(values: Numbers): number {
	let result: number = 0;
	for (const value of values) result += value;
	return result;
}
import type { Numbers } from "./types.ts";
