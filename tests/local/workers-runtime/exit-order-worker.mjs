import { parentPort, workerData } from "node:worker_threads";

for (let index = 0; index < 32; index++) parentPort.postMessage(index);
Atomics.store(new Int32Array(workerData), 0, 1);
parentPort.close();
