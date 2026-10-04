import { parentPort, workerData } from "node:worker_threads";
import { writeFileAtomically } from "../../src/atomic-file.ts";

const { destination, barrier, writer } = workerData as {
	destination: string;
	barrier: SharedArrayBuffer;
	writer: number;
};
const ready = new Int32Array(barrier);
parentPort!.postMessage("ready");
if (Atomics.wait(ready, 0, 0, 5_000) === "timed-out") {
	throw new Error("publisher barrier timed out");
}
for (let iteration = 0; iteration < 32; iteration++) {
	writeFileAtomically(
		destination,
		JSON.stringify({ writer, iteration, payload: String(writer).repeat(64 * 1024) }),
	);
}
