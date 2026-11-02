import { getMode, getThread, setThread } from "maligator:ffi/globals";
import { parentPort } from "maligator:workers";

if (parentPort === null) throw new Error("expected worker port");
const port = parentPort;
port.onmessage = () => {
	const initial = getThread();
	setThread(33);
	port.postMessage({ initial, updated: getThread(), mode: getMode() });
};
port.start();
