import { Worker, createWorkerUrl } from "maligator:workers";

const okUrl = createWorkerUrl("./tla-ok.mjs", import.meta.url);
const rejectUrl = createWorkerUrl("./tla-reject.mjs", import.meta.url);
const undefinedUrl = createWorkerUrl("./tla-undefined.mjs", import.meta.url);
const pendingUrl = createWorkerUrl("./tla-pending.mjs", import.meta.url);

async function readyFollowsTopLevelAwait() {
	const flag = new Int32Array(new SharedArrayBuffer(4));
	const worker = new Worker(okUrl, { data: flag.buffer });
	await worker.ready;
	const evaluatedAtReady = Atomics.load(flag, 0);
	const exit = await worker.closed;
	console.log("tla-ok:", JSON.stringify([evaluatedAtReady, exit.reason, exit.code]));
}

async function startupFailure(url) {
	const worker = new Worker(url);
	const events = [];
	worker.addEventListener("error", (event) => {
		events.push([event.type, event.message, "error" in event, event.error]);
	});
	let ready = "fulfilled";
	try {
		await worker.ready;
	} catch (error) {
		ready = { error };
	}
	const exit = await worker.closed;
	return { ready, exit, events };
}

async function rejectedTopLevelAwaitFailsStartup() {
	const { ready, exit, events } = await startupFailure(rejectUrl);
	const [event] = events;
	console.log(
		"tla-reject:",
		JSON.stringify([
			ready.error?.message,
			exit.reason,
			exit.code,
			exit.error?.message,
			events.length,
			event?.[0],
			event?.[1],
			event?.[3] instanceof Error,
		]),
	);
}

async function undefinedRejectionIsPreserved() {
	const { ready, exit, events } = await startupFailure(undefinedUrl);
	console.log(
		"tla-undefined:",
		JSON.stringify([
			typeof ready === "object" && ready.error === undefined,
			exit.reason,
			"error" in exit && exit.error === undefined,
			events.length === 1 && events[0][2] && events[0][3] === undefined,
		]),
	);
}

async function unsettledTopLevelAwaitFailsStartup() {
	const { ready, exit } = await startupFailure(pendingUrl);
	console.log(
		"tla-pending:",
		JSON.stringify([ready.error instanceof Error, exit.reason, exit.code]),
	);
}

await readyFollowsTopLevelAwait();
await rejectedTopLevelAwaitFailsStartup();
await undefinedRejectionIsPreserved();
await unsettledTopLevelAwaitFailsStartup();
