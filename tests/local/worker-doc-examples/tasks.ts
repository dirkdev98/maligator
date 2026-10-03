import type { TaskContext } from "maligator:workers";

export function sum(context: TaskContext, values: Array<number>): number {
	let total = 0;
	for (const value of values) {
		context.throwIfCancelled();
		total += value;
	}
	return total;
}

export async function waitForCancellation(context: TaskContext): Promise<void> {
	context.throwIfCancelled();
	await new Promise<void>((resolve) => {
		context.signal.addEventListener("abort", () => resolve(), { once: true });
	});
	context.throwIfCancelled();
}
