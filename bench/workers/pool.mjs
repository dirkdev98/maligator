import { createPool, createWorkerUrl } from "maligator:workers";
import { runWorkerPoolBenchmark } from "./tinypool-run.mjs";

const entry = createWorkerUrl("./jobs.mjs", import.meta.url);
await runWorkerPoolBenchmark((size) => {
	const pool = createPool(entry, { size, maxQueuedTasks: 64 });
	return {
		run: (input, transfer) => pool.run("task", [input], { transfer }),
		close: () => pool.close(),
	};
});
