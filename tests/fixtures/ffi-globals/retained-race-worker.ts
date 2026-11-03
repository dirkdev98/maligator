import {
	setRetainedTitle,
	setRetainedBytes,
	getRetainedTitle,
	getRetainedBytes,
	getRetainedCount,
} from "maligator:ffi/globals";
import { parentPort } from "maligator:workers";
if (parentPort === null) throw new Error("expected worker port");
const port = parentPort;
port.onmessage = (event) => {
	const size = event.data as number;
	for (let round = 0; round < 250; round++) {
		setRetainedBytes(new Uint8Array(size).fill(size));
		setRetainedTitle("é".repeat(size));
		const bytes = getRetainedBytes();
		if (
			bytes === null ||
			(bytes.length !== 17 && bytes.length !== 37) ||
			!bytes.every((byte) => byte === bytes.length)
		)
			throw new Error("concurrent byte snapshot mixed native generations");
		const text = getRetainedTitle();
		if (text !== "é".repeat(17) && text !== "é".repeat(37))
			throw new Error("concurrent text snapshot mixed native generations");
		const count = getRetainedCount();
		if (count !== 17 && count !== 37)
			throw new Error("concurrent count read was not synchronized");
	}
	port.postMessage("done");
};
port.start();
