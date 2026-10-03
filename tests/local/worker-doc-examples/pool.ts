import { createPool, createWorkerUrl } from "maligator:workers";

const tasks = createWorkerUrl<typeof import("./tasks.ts")>("./tasks.ts", import.meta.url);
const pool = createPool(tasks, { size: 2, maxQueuedTasks: 4 });

try {
	await pool.ready;
	console.log(await pool.run("sum", [[1, 2, 3]]));

	const inputs: Array<[Array<number>]> = [[[1, 2]], [[3, 4]]];
	for await (const total of pool.map("sum", inputs, { window: 2 })) {
		console.log(total);
	}

	const controller = new AbortController();
	const pending = pool.run("waitForCancellation", [], {
		signal: controller.signal,
	});
	const cancelled = pending.then(
		() => false,
		(reason: unknown) => reason === controller.signal.reason,
	);
	controller.abort();
	console.log(await cancelled);
} finally {
	await pool.close();
}
