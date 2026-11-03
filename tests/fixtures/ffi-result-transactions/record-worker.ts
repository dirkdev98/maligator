import * as c from "maligator:ffi/transactions";
import { parentPort } from "maligator:workers";
if (parentPort === null) throw new Error("expected a worker port");
const port = parentPort;
port.onmessage = (event) => {
	if (event.data === "caller") void c.callerWaitAsync(4n);
	else if (event.data === "tagged") void c.taggedWaitAsync();
	else if (event.data === "constTagged") void c.constTaggedWaitAsync();
	else if (event.data === "table") void c.tableWaitAsync();
	else if (event.data === "grid") void c.gridWaitAsync();
	else if (event.data === "policy") void c.policyWaitAsync();
	else if (event.data === "choice") void c.choiceWaitAsync();
	else void c.recordWaitAsync();
	port.postMessage("admitted");
};
port.start();
