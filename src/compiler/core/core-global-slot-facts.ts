import type { CoreExactHeapBrand } from "./core-heap-brands.ts";
import type { CoreProgram } from "./core-store.ts";

const installed = new WeakMap<CoreProgram, ReadonlyMap<number, CoreExactHeapBrand>>();

// Like private field facts, these are installed before any analysis that reads them is cached.
export function installCoreGlobalSlotBrands(
	program: CoreProgram,
	brands: ReadonlyMap<number, CoreExactHeapBrand>,
): void {
	installed.set(program, brands);
}

export function coreGlobalSlotBrands(
	program: CoreProgram,
): ReadonlyMap<number, CoreExactHeapBrand> | undefined {
	return installed.get(program);
}
