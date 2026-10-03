import { parentPort, workerData, failCurrent } from "maligator:internal/workers";
import { unwrapTransfer } from "./transfer.mjs";

const taskModule = await import(workerData.entry.href);
let active = false;
let activeId;

parentPort.addEventListener("message", async (event) => {
	const request = event.data;
	if (active) throw new Error("Task executor received overlapping work");
	active = true;
	const controller = new AbortController();
	activeId = request.id;
	const cancellation = Atomics.waitAsync(request.flag, 0, 0);
	if (cancellation.async) {
		cancellation.value.then(() => {
			if (activeId === request.id) controller.abort();
		});
	}
	function throwIfCancelled() {
		if (Atomics.load(request.flag, 0) === 0) return;
		if (!controller.signal.aborted) controller.abort();
		const error = new Error("Worker task was cancelled");
		error.name = "AbortError";
		throw error;
	}
	try {
		throwIfCancelled();
		const task = taskModule[request.name];
		if (typeof task !== "function")
			throw new TypeError(`Worker export ${request.name} is not callable`);
		const result = unwrapTransfer(
			await task({ signal: controller.signal, throwIfCancelled }, ...request.args),
		);
		throwIfCancelled();
		parentPort.postMessage(
			{ id: request.id, ok: true, value: result.value },
			result.transfer,
		);
	} catch (error) {
		try {
			parentPort.postMessage({ id: request.id, ok: false, value: error });
		} catch {
			try {
				parentPort.postMessage({
					id: request.id,
					ok: false,
					value: new Error("Worker task failed with an uncloneable value"),
				});
			} catch {
				failCurrent();
			}
		}
	} finally {
		Atomics.store(request.flag, 0, 1);
		Atomics.notify(request.flag, 0);
		active = false;
		activeId = undefined;
	}
});
parentPort.start();
