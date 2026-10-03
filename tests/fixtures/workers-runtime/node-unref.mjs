import { Worker } from "node:worker_threads";
import { createWorkerUrl } from "maligator:workers";

const worker = new Worker(createWorkerUrl("./spin.mjs", import.meta.url).href);
worker.unref();
console.log("node-unref PASS");
