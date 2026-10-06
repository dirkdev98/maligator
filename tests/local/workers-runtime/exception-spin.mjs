globalThis.retryThrows = () => {
	throw 0;
};
// Ready resolves after evaluation, so the spin starts from a macrotask.
setTimeout(() => {
	let started = false;
	for (;;) {
		try {
			globalThis.retryThrows();
			return;
		} catch {
			if (!started) {
				started = true;
				parentPort.postMessage("spinning");
			}
		}
	}
}, 0);
import { parentPort } from "maligator:workers";
