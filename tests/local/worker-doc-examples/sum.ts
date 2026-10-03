import type { TaskContext } from "maligator:workers";

export function sum(context: TaskContext, values: Array<number>): number {
	context.throwIfCancelled();
	return values.reduce((total, value) => total + value, 0);
}
