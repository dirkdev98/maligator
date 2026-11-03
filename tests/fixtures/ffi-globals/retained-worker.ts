import {
	setRetainedTitle,
	setRetainedBytes,
	getRetainedTitle,
	getRetainedBytes,
} from "maligator:ffi/globals";
import { parentPort } from "maligator:workers";
if (parentPort === null) throw new Error("expected worker port");
const port = parentPort;
port.onmessage = () => {
	setRetainedTitle("worker 🚀");
	setRetainedBytes(new Uint8Array([7, 8, 9]));
	port.postMessage({ text: getRetainedTitle(), bytes: getRetainedBytes() });
};
port.start();
