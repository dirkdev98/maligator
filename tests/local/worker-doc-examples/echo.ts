import { parentPort } from "maligator:workers";

if (parentPort === null) throw new Error("Run this module as a worker");
const port = parentPort;
port.onmessage = (event) => {
	port.postMessage(String(event.data));
};
port.start();
