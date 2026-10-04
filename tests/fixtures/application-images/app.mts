import type { FixtureBridge } from "./types.ts";
const bridge = mal as unknown as FixtureBridge;
import process from "node:process";
import { isMainThread, threadId, parentPort, workerData } from "node:worker_threads";
import { ready } from "maligator:application";
import { createWorkerUrl, Worker } from "maligator:workers";
import type { ApplicationData, ChildResult, FixtureGlobals } from "./types.ts";
const generation = "first";

const data = bridge._applicationData() as ApplicationData;
const globals = globalThis as typeof globalThis & FixtureGlobals;
if (data.mode === "reject") await Promise.reject(new Error("application TLA rejected"));
if (data.mode === "unresolved") await new Promise(() => {});
if (data.mode === "exit") process.exit(7);
if (data.mode === "throw-result") {
	bridge._applicationResult("before throw");
	throw new Error("after result");
}
globals.launchCount = (globals.launchCount || 0) + 1;
const url = createWorkerUrl("./worker.mts", import.meta.url);
const child = new Worker(url);
await child.ready;
const childResult = new Promise<ChildResult>((resolve) => {
	child.port.addEventListener(
		"message",
		(event) => resolve((event as MessageEvent<ChildResult>).data),
		{ once: true },
	);
});
child.port.postMessage(null);
const response = await Promise.race([
	childResult,
	child.closed.then((exit) => {
		throw exit.error instanceof Error
			? exit.error
			: new Error(`child exited without a response ${JSON.stringify(exit)}`);
	}),
]);
setInterval(() => {}, 1000);
setInterval(() => {
	if (Atomics.load(new Int32Array(data.gate), 0) === 0) return;
	if (ready() !== true || ready() !== true)
		throw new Error("application readiness must be idempotent");
	if (data.mode === "park") return;
	bridge._applicationResult(
		data.mode === "undefined"
			? undefined
			: {
					generation,
					child: response,
					main: isMainThread,
					threadId,
					parentPort,
					workerData: workerData as unknown,
					argv: process.argv,
					count: globals.launchCount,
					order: globals.fragmentOrder,
					data,
					resources: bridge._applicationResources(),
					url,
				},
	);
}, 10);
