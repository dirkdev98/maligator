import { workerData } from "maligator:workers";

await new Promise((resolve) => setTimeout(resolve, 30));
Atomics.store(new Int32Array(workerData), 0, 1);
