import * as c from "maligator:ffi/lifetime";
import { parentPort } from "maligator:workers";
if (parentPort === null) throw new Error("expected a worker port");
const port = parentPort;
port.onmessage = () => {
	const root = c.copied_new(107);
	const child = root.child!;
	c.copied_subscribe(root, () => c.copied_value(root));
	c.life_keep_child(() => child);
	port.postMessage("ready");
};
port.start();
