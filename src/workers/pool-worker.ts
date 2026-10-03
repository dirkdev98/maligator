import { parentPort, workerData, failCurrent } from "maligator:internal/workers";
import type { MessagePort } from "maligator:internal/workers";
import type { TaskContext, WorkerUrl } from "maligator:workers";
import type { TaskRequest, TaskResponse } from "./runtime.ts";
import { unwrapTransfer } from "./transfer.ts";

// Only createPool launches this bootstrap and supplies its private request protocol.
const data = workerData as { readonly entry: WorkerUrl };
const port = parentPort as MessagePort<TaskResponse, TaskRequest>;
const taskModule = (await import(data.entry.href)) as Record<string, unknown>;
let active = false;
let activeId: number | undefined;

port.addEventListener("message", async (event) => {
	const request = event.data;
	if (active) throw new Error("Task executor received overlapping work");
	active = true;
	const controller = new AbortController();
	activeId = request.id;
	const cancellation = Atomics.waitAsync(request.flag, 0, 0);
	if (cancellation.async) {
		void cancellation.value.then(() => {
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
			await (task as (context: TaskContext, ...args: Array<unknown>) => unknown)(
				{ signal: controller.signal, throwIfCancelled },
				...request.args,
			),
		);
		throwIfCancelled();
		port.postMessage({ id: request.id, ok: true, value: result.value }, result.transfer);
	} catch (error) {
		try {
			port.postMessage({ id: request.id, ok: false, value: error });
		} catch {
			try {
				port.postMessage({
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
port.start();
