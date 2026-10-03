import { createWorkerUrl, Worker } from "maligator:workers";
import { childSignalOutcomes, expectedOutcomes } from "./outcomes.mjs";

function check(value, message) {
	if (!value) throw new Error(message);
}

// The owner's SIGTERM listener must not intercept a signal sent to a forked child.
let ownerSigterm = false;
const onSigterm = () => {
	ownerSigterm = true;
};
process.on("SIGTERM", onSigterm);

const owner = JSON.stringify(await childSignalOutcomes());
check(owner === expectedOutcomes, `owner thread outcomes ${owner}`);

// Worker threads block every signal; their children must not inherit that mask.
const worker = new Worker(createWorkerUrl("./worker.mjs", import.meta.url));
const reported = new Promise((resolve) =>
	worker.port.addEventListener("message", (event) => resolve(event.data), { once: true }),
);
worker.port.start();
const fromWorker = JSON.stringify(await reported);
check(fromWorker === expectedOutcomes, `worker thread outcomes ${fromWorker}`);
await worker.terminate();

process.off("SIGTERM", onSigterm);
check(!ownerSigterm, "owner SIGTERM listener stayed quiet");
console.log("worker-child-signals PASS");
