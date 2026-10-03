import { createPool, createWorkerUrl, Worker } from "maligator:workers";

const originalRef = Worker.prototype.ref;
const originalUnref = Worker.prototype.unref;
const pools = [];

try {
	Worker.prototype.ref = function () {
		throw new Error("pool called a patched Worker.ref");
	};
	Worker.prototype.unref = function () {
		throw new Error("pool called a patched Worker.unref");
	};
	const entry = createWorkerUrl("../workers/jobs.mjs", import.meta.url);
	const first = createPool(entry, { size: 2 });
	pools.push(first);
	const second = createPool(entry, { size: 1 });
	pools.push(second);
	await Promise.all([first.ready, second.ready]);
	const firstTask = first.run("delay", [11]);
	first.unref();
	first.ref();
	const secondTask = second.run("sum", [[2, 3]]);
	if ((await firstTask) !== 11 || (await secondTask) !== 5)
		throw new Error("pool task result changed");
	await Promise.all([first.close(), second.close()]);
	console.log("pool-private-ref PASS");
} finally {
	Worker.prototype.ref = originalRef;
	Worker.prototype.unref = originalUnref;
	await Promise.all(pools.map((pool) => pool.terminate()));
}
