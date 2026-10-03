import { performance } from "node:perf_hooks";
import { MessageChannel } from "node:worker_threads";

const mode = process.argv[2] ?? "scalar";
const count = Number(process.argv[3] ?? "10000");
if (
	!["scalar", "clone", "transfer", "timers", "web"].includes(mode) ||
	!Number.isSafeInteger(count) ||
	count < 1 ||
	count > 1_000_000
)
	throw new Error("invalid channel workload");

async function run(operations) {
	const { port1, port2 } = new MessageChannel();
	let checksum = 0;
	let received = 0;
	let webReceived = 0;
	const timerDelays = [];
	const timerTasks = [];
	const start = performance.now();
	if (mode === "timers") {
		for (const delay of [1, 2, 3, 4, 5]) {
			timerTasks.push(
				new Promise((resolve) =>
					setTimeout(() => {
						timerDelays.push(Math.max(0, performance.now() - start - delay));
						resolve();
					}, delay),
				),
			);
		}
	}
	function post(index) {
		if (mode === "transfer") {
			const bytes = new Uint8Array(64);
			bytes[0] = index & 255;
			port1.postMessage({ index, buffer: bytes.buffer }, [bytes.buffer]);
			if (bytes.buffer.byteLength !== 0) throw new Error("transfer failed to detach");
		} else if (mode === "clone") {
			port1.postMessage({ index, values: [index, index + 1], text: "value" + index });
		} else {
			port1.postMessage(index);
		}
	}
	try {
		if (mode === "web") {
			port2.addEventListener("message", (event) => {
				if (event.data !== webReceived) throw new Error("web observer ordering changed");
				webReceived++;
			});
		}
		await new Promise((resolve, reject) => {
			port2.on("message", (value) => {
				try {
					const index = typeof value === "number" ? value : value.index;
					if (index !== received) throw new Error("message ordering changed");
					if (
						mode === "clone" &&
						(value.values[1] !== index + 1 || value.text !== "value" + index)
					)
						throw new Error("clone payload mismatch");
					if (mode === "transfer" && new Uint8Array(value.buffer)[0] !== (index & 255))
						throw new Error("transferred payload mismatch");
					checksum = (checksum + index) | 0;
					if (++received === operations) resolve();
					else post(received);
				} catch (error) {
					reject(error);
				}
			});
			post(0);
		});
		if (mode === "web" && webReceived !== operations)
			throw new Error("web observer missed a message");
		await Promise.all(timerTasks);
		return { operations, checksum, elapsedMs: performance.now() - start, timerDelays };
	} finally {
		port1.close();
		port2.close();
	}
}

await run(Math.min(count, 1000));
const result = await run(count);
console.log(JSON.stringify({ mode, ...result }));
