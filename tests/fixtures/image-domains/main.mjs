import { createWorkerUrl, Worker } from "maligator:workers";

function check(value, message) {
	if (!value) throw new Error(message);
}

function request(worker, command) {
	const response = new Promise((resolve) => {
		worker.port.addEventListener("message", (event) => resolve(event.data), {
			once: true,
		});
	});
	worker.port.postMessage(command);
	return response;
}

async function inspect(url, expected) {
	const worker = new Worker(url);
	await worker.ready;
	const result = await request(worker, "leaf");
	check(
		result.worker === expected && result.leaf === expected,
		"generation and child inheritance",
	);
	await worker.terminate();
}

if (globalThis.savedPhase) {
	await inspect(globalThis.takeDomainUrl(), "first");
	globalThis.domainPassed();
} else {
	const first = globalThis.initialGeneration;
	const second = first === "first" ? "second" : "first";
	const oldUrl = createWorkerUrl("./worker.mjs", import.meta.url);
	const oldWorker = new Worker(oldUrl);
	await oldWorker.ready;
	globalThis.switchImageDomain();
	const nextUrl = createWorkerUrl("./worker.mjs", import.meta.url);
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

	const receiver = new Worker(createWorkerUrl("./receiver.mjs", import.meta.url));
	await receiver.ready;
	const transported = await request(receiver, oldUrl);
	check(
		transported.worker === first && transported.leaf === first,
		"transport retains origin domain",
	);
	await receiver.terminate();

	const getterWorker = new Worker(nextUrl.href, {
		get data() {
			globalThis.switchImageDomain();
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
	if (globalThis.savePhase) globalThis.saveDomainUrl(oldUrl);
	for (let index = 0; index < 16; index++) globalThis.switchImageDomain();

	const ownedTree = new Worker(oldUrl);
	await ownedTree.ready;
	await request(ownedTree, "park-child");
	ownedTree.unref();
	globalThis.domainPassed();
}
