import type { FixtureBridge } from "./types.ts";
const globals = globalThis as typeof globalThis & { fragmentCount?: number };
(mal as unknown as FixtureBridge)._applicationResult(globals.fragmentCount);
