import { createWorkerUrl } from "maligator:workers";
import Tinypool from "tinypool";

function check(value, message) {
	if (!value) throw new Error(message);
}
const filename = createWorkerUrl("./jobs.mjs", import.meta.url).href;
const pool = new Tinypool({ filename, minThreads: 2, maxThreads: 2, maxQueue: 8 });
const shared = new SharedArrayBuffer(4);
try {
	const results = await Promise.all(
		[1, 2, 3, 4].map((value) => pool.run({ value, shared })),
	);
	check(
		JSON.stringify(results.map((item) => item.value)) === "[2,4,6,8]",
		"unmodified task scheduling",
	);
	check(
		results.every((item) => item.threadId > 0) &&
			new Set(results.map((item) => item.threadId)).size === 2,
		"two native workers",
	);
	check(Atomics.load(new Int32Array(shared), 0) === 4, "real shared memory");
	const reused = await pool.run({ value: 5 });
	check(reused.value === 10 && reused.counter > 1, "persistent module and repeated task");
	let error;
	try {
		await pool.run({ fail: true });
	} catch (caught) {
		error = caught;
	}
	check(
		error instanceof TypeError && error.message === "remote failure",
		"cloned remote failure",
	);
} finally {
	await pool.destroy();
}
console.log("tinypool-workers PASS");
