import { createPool, createWorkerUrl } from "maligator:workers";

const tasks = createWorkerUrl<typeof import("./transfer-task.ts")>(
	"./transfer-task.ts",
	import.meta.url,
);
const pool = createPool(tasks, { size: 1 });

try {
	await pool.ready;
	const bytes = new Uint8Array([1, 2, 3]);
	const pending = pool.run("reverse", [bytes.buffer], {
		transfer: [bytes.buffer],
	});
	console.log(bytes.byteLength);
	const result = new Uint8Array(await pending);
	console.log(Array.from(result).join(","));
} finally {
	await pool.close();
}
