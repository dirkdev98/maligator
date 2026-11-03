import * as c from "maligator:ffi/transactions";
import { parentPort } from "maligator:workers";

if (parentPort === null) throw new Error("expected a worker port");
c.tx_watch(() => {
	c.tx_pool_keep(() => c.tx_pool_peek()!);
	throw new RangeError("result release failed");
});
try {
	c.tx_pool_reentry();
	throw new Error("expected failed delivery");
} catch (error) {
	if (!(error instanceof RangeError)) throw error;
}
c.tx_watch(null);
parentPort.postMessage("retired");
