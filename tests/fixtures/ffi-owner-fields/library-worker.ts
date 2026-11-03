import * as c from "maligator:ffi/owner_fields";
import { parentPort } from "maligator:workers";
if (parentPort === null) throw new Error("expected worker port");
const port = parentPort;
port.onmessage = (event) => {
	const root = c.owner_result_program(Number(event.data));
	const item = root.library!;
	const value = c.owner_child_value(item);
	item[Symbol.dispose]();
	root[Symbol.dispose]();
	port.postMessage(value);
};
port.start();
