// The Worker constructor and the entry URL both reach `new Worker` through values:
// a lazily loaded builtin module and a helper that builds the URL in another module.
import { unpackEntry } from "./entries.mjs";

const { Worker } = process.getBuiltinModule("node:worker_threads");
const worker = new Worker(unpackEntry(), { workerData: { value: 21 } });
worker.on("message", (message) => console.log("message", JSON.stringify(message)));
worker.on("error", (error) => console.log("error", error.message));
worker.on("exit", (code) => console.log("exit", code));
