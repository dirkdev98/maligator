import { isMainThread } from "node:worker_threads";

globalThis.dispatchCount = (globalThis.dispatchCount ?? 0) + 1;
if (globalThis.dispatchCount !== 1) throw new Error("worker globals were shared");

if (isMainThread) await import("./workers/main.mjs");
else await import(process.argv[1]);
