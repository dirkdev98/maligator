import * as c from "maligator:ffi/transactions";
import { parentPort } from "maligator:workers";
if (parentPort === null) throw new Error("expected a worker port");
const port = parentPort;
port.onmessage = () => {
	void c.recordWaitAsync();
	port.postMessage("admitted");
};
port.start();
