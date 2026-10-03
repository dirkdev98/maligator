import { value as b } from "./cycle-b.mjs";
globalThis.cycleACount = (globalThis.cycleACount ?? 0) + 1;
export function initial() {
	return 41;
}
export const value = b + 1;
