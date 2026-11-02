import { work_answer } from "maligator:ffi/work";
import { parentPort } from "maligator:workers";

if (parentPort === null) throw new Error("expected a worker port");
const port = parentPort;
port.onmessage = (event) => {
	if (typeof event.data !== "number") throw new Error("expected a number");
	port.postMessage(work_answer(event.data));
};
port.start();
