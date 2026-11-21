import type { FixtureBridge } from "./types.ts";
const globals = globalThis as typeof globalThis & { fragmentCount?: number };
(Reflect.get(globalThis, "mal") as FixtureBridge)._applicationResult(
	globals.fragmentCount,
);
