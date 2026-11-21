import type { FixtureBridge } from "./types.ts";

const generation = "first";
const globals = globalThis as typeof globalThis & { fragmentCount?: number };
const bridge = Reflect.get(globalThis, "mal") as FixtureBridge;
bridge._applicationResult(`${generation}:${globals.fragmentCount}`);
