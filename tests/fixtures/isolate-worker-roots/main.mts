import { createWorkerUrl, Worker } from "maligator:workers";

const globals = globalThis as typeof globalThis & {
	startOtherRoot(): void;
	checkOtherRoot(): void;
};

const worker = new Worker(createWorkerUrl("./worker.mts", import.meta.url));
await worker.ready;
globals.startOtherRoot();
await worker.terminate();
globals.checkOtherRoot();
