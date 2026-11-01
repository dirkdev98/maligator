import process from "node:process";
import * as c from "maligator:ffi/worker";

c.worker_expect_clean_shutdown();
const mode = process.argv[2];
if (mode === "queued") {
	c.worker_hold();
	const resources: Array<c.WorkerResource> = [];
	let failed = false;
	try {
		for (let value = 0; value < 4096 && !failed; value++) {
			const resource = c.worker_open(value)!;
			resources.push(resource);
			c.worker_watch(resource, () => {});
			void c.worker_close_async(resource).catch((error: unknown) => {
				if (!(error instanceof Error) || !error.message.includes("scheduled"))
					throw error;
				if (c.worker_value(resource) !== value)
					throw new Error("rejected close lost its handle");
				failed = true;
			});
			await Promise.resolve();
		}
		if (!failed) throw new Error("worker queue did not reject within the test budget");
		if (resources.length === 0) throw new Error("no queued resources");
	} finally {
		c.worker_unblock_later();
	}
} else {
	if (mode === "running") c.worker_hold();
	const resource = c.worker_open(19)!;
	if (mode === "running") c.worker_watch_direct(resource, () => {});
	else c.worker_watch(resource, () => {});
	void c.worker_close_async(resource);
	if (mode === "running") {
		c.worker_wait_started();
		c.worker_unblock_later();
	} else {
		c.worker_wait_finished();
	}
}
throw new Error("worker shutdown requested");
