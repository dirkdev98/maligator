import * as c from "maligator:ffi/arrays";
import { parentPort } from "maligator:workers";
const port = parentPort;
if (port === null) throw new Error("worker requires a parent port");
port.onmessage = () => {
	void c.tableWaitAsync();
	port.postMessage("admitted");
};
port.start();
