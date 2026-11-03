import * as c from "maligator:ffi/owner_fields";
import { parentPort } from "maligator:workers";
if (parentPort === null) throw new Error("expected worker port");
const port = parentPort;
port.onmessage = (event) => {
	const kind = String(event.data);
	let child: c.OwnerChild | null = null;
	let root: c.OwnerResult | null = null;
	const poll = () => (child === null && root === null ? 2 : 1);
	if (kind === "new") {
		void c.newWaitAsync(92, () => 1);
	} else if (kind === "new-outputs") {
		void c.newWaitOutputsAsync(92, () => 1);
	} else {
		void c.globalWaitAsync(poll);
		if (kind === "owned") child = c.owner_child_new(92);
		else {
			root = c.owner_result_new(92);
			child = root.first!;
		}
		c.owner_global_set(child!);
	}
	port.postMessage(kind);
};
port.start();
