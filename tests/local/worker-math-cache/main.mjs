import { createPool, createWorkerUrl } from "maligator:workers";

function check(value, message) {
	if (!value) throw new Error(message);
}

const originalAbs = Math.abs;
const originalMin = Math.min;
const entry = createWorkerUrl("./jobs.mjs", import.meta.url);
const pool = createPool(entry, { size: 2 });
try {
	await pool.ready;
	const gate = new SharedArrayBuffer(4);
	const values = [-2.75, 2.5, -1.5];
	const first = pool.run("exercise", [0, gate, values]);
	const second = pool.run("exercise", [1, gate, values]);
	const totals = await Promise.all([first, second]);
	check(totals[0] === 384 && totals[1] === 384, "both worker results");
	check(
		Math.abs === originalAbs && Math.min === originalMin,
		"main isolate Math identity",
	);
	console.log("worker-math-cache PASS");
} finally {
	await pool.terminate();
}
