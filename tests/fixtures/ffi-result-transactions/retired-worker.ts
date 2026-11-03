import * as c from "maligator:ffi/transactions";
import { parentPort } from "maligator:workers";

if (parentPort === null) throw new Error("expected a worker port");
const port = parentPort;
c.tx_watch(() => {
	c.tx_native_keep(() => c.tx_peek()!);
	throw new RangeError("result release failed");
});
try {
	c.tx_reentry(1);
	throw new Error("expected failed delivery");
} catch (error) {
	if (!(error instanceof RangeError)) throw error;
}
c.tx_watch(null);
port.onmessage = () => {
	void c.nativeWaitAsync();
	port.postMessage("admitted");
};
port.start();
port.postMessage("retired");
