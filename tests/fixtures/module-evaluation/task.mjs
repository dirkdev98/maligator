import { value as initial } from "./task-dependency.mjs";
globalThis.taskCount = (globalThis.taskCount ?? 0) + 1;
export let value = initial;
export function increment() {
	value++;
}
