import * as c from "maligator:ffi/lifetime";
import { parentPort } from "maligator:workers";
if (parentPort === null) throw new Error("expected a worker port");
const port = parentPort;
port.onmessage = () => {
	const root = c.life_new(77)!;
	const child = root.child!;
	c.life_subscribe(child, () => c.life_value(child));
	c.life_keep_root(() => root);
	port.postMessage("ready");
};
port.start();
