import type { WorkerUrl, Worker as WorkerInstance } from "maligator:workers";
import type { DomainGlobals, GenerationResult } from "./types.ts";
const globals = globalThis as typeof globalThis & DomainGlobals;
import { createWorkerUrl, Worker } from "maligator:workers";

function check(value: unknown, message: string) {
	if (!value) throw new Error(message);
}

function request(worker: WorkerInstance, command: unknown) {
	const response = new Promise<GenerationResult>((resolve) => {
		worker.port.addEventListener(
			"message",
			(event) => resolve((event as MessageEvent<GenerationResult>).data),
			{
				once: true,
			},
		);
	});
	worker.port.postMessage(command);
	return response;
}

async function inspect(url: WorkerUrl, expected: string) {
	const worker = new Worker(url);
	await worker.ready;
	const result = await request(worker, "leaf");
	check(
		result.worker === expected && result.leaf === expected,
		"generation and child inheritance",
	);
	await worker.terminate();
}

if (globals.savedPhase) {
	await inspect(globals.takeDomainUrl(), "first");
	globals.domainPassed();
} else {
	const first = globals.initialGeneration;
	const second = first === "first" ? "second" : "first";
	const oldUrl = createWorkerUrl("./worker.mts", import.meta.url);
	const oldWorker = new Worker(oldUrl);
	await oldWorker.ready;
	globals.switchImageDomain();
	const nextUrl = createWorkerUrl("./worker.mts", import.meta.url);
	check(
		nextUrl.href === oldUrl.href && nextUrl !== oldUrl,
		"same href has distinct generations",
	);
	check(
		structuredClone(oldUrl) === oldUrl,
		"clone retains its domain and descriptor identity",
	);
	await inspect(nextUrl, second);
	await inspect(oldUrl, first);
	const oldResult = await request(oldWorker, "leaf");
	check(
		oldResult.worker === first && oldResult.leaf === first,
		"live worker retains its child domain",
	);

	const receiver = new Worker(createWorkerUrl("./receiver.mts", import.meta.url));
	await receiver.ready;
	const transported = await request(receiver, oldUrl);
	check(
		transported.worker === first && transported.leaf === first,
		"transport retains origin domain",
	);
	await receiver.terminate();

	const getterWorker = new Worker(nextUrl.href as unknown as WorkerUrl, {
		get data() {
			globals.switchImageDomain();
			return null;
		},
	});
	await getterWorker.ready;
	const getterResult = await request(getterWorker, "leaf");
	check(
		getterResult.worker === second && getterResult.leaf === second,
		"getter cannot replace admitted image",
	);
	await getterWorker.terminate();
	await oldWorker.terminate();
	if (globals.savePhase) globals.saveDomainUrl(oldUrl);
	for (let index = 0; index < 16; index++) globals.switchImageDomain();

	const ownedTree = new Worker(oldUrl);
	await ownedTree.ready;
	await request(ownedTree, "park-child");
	ownedTree.unref();
	globals.domainPassed();
}
