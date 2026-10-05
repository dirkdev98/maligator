import type { TaskContext } from "maligator:workers";
import { createPool, createWorkerUrl } from "maligator:workers";

const entry = createWorkerUrl<{
	waitForCancellation(context: TaskContext): Promise<void>;
}>("./tasks.ts", import.meta.url);
const pool = createPool(entry, { size: 1 });
try {
	await pool.ready;
	const controller = new AbortController();
	const pending = pool.run("waitForCancellation", [], { signal: controller.signal });
	const result = pending.catch((reason: unknown) => {
		if (reason !== controller.signal.reason) throw reason;
		return "cancelled";
	});
	controller.abort();
	console.log(await result);
} finally {
	await pool.close();
}
