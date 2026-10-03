import { initial } from "./cycle-a.mjs";
globalThis.cycleBCount = (globalThis.cycleBCount ?? 0) + 1;
await Promise.resolve();
export const value = initial();
