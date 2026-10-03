globalThis.deferredModuleCount = (globalThis.deferredModuleCount ?? 0) + 1;
export let value = 41;
export function increment() {
	value++;
}
