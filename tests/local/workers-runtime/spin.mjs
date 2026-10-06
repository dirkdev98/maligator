// Ready resolves after evaluation, so the spin starts from a macrotask.
setTimeout(() => {
	parentPort.postMessage("spinning");
	let counter = 0;
	for (;;) {
		try {
			for (;;) counter = (counter + 1) | 0;
		} catch {
			// Termination is uncatchable: reaching here would keep the worker alive.
		}
	}
}, 0);
import { parentPort } from "maligator:workers";
