import { threadId } from "node:worker_threads";
let counter = 0;
export default function task(input) {
	counter++;
	if (input.fail) throw new TypeError("remote failure");
	if (input.shared !== undefined) Atomics.add(new Int32Array(input.shared), 0, 1);
	return { threadId, counter, value: input.value * 2 };
}
