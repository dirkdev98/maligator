import * as c from "maligator:ffi/owner_fields";
import { parentPort } from "maligator:workers";
if (parentPort === null) throw new Error("expected worker port");
const port = parentPort;
port.onmessage = (event) => {
	const root = c.owner_result_new(Number(event.data));
	const child = root.first!;
	c.owner_watch_child(child, () => {});
	port.postMessage(c.owner_child_value(child));
};
port.start();
