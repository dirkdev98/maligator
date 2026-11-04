import * as c from "maligator:ffi/lifetime";
import { parentPort } from "maligator:workers";
if (parentPort === null) throw new Error("expected a worker port");
const port = parentPort;
port.onmessage = (event) => {
	if (event.data === "lease") {
		const root = c.CallerRoot();
		root.data = new Uint8Array([37, 41]);
		c.caller_init_void(root, 499);
		c.caller_subscribe(root, () => c.caller_value(root));
		c.life_keep_child(() => root.child!);
	} else {
		const count = event.data === "queued" ? 32 : 1;
		for (let index = 0; index < count; index++)
			void c.callerInitAsync(c.CallerRoot(), 503, event.data === "failure" ? 5 : 4);
	}
	port.postMessage("admitted");
};
port.start();
