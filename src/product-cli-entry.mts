import { isMainThread } from "node:worker_threads";

// Worker launch contexts retain their declared URL even when the baked code is shared.
if (isMainThread) await import("./product-cli-main.mts");
// oxlint-disable-next-line import/no-dynamic-require -- A worker loads the entry it was launched with.
else await import(process.argv[1]!);
