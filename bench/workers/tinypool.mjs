import { createWorkerUrl } from "maligator:workers";
import Tinypool from "tinypool";
import { runWorkerPoolBenchmark } from "./tinypool-run.mjs";

const filename = createWorkerUrl("./jobs.mjs", import.meta.url).href;
await runWorkerPoolBenchmark((size) => {
	const pool = new Tinypool({
		filename,
		minThreads: size,
		maxThreads: size,
		maxQueue: 64,
	});
	return {
		run: (input, transferList) => pool.run(input, { transferList }),
		close: () => pool.destroy(),
	};
});
