import { createPool, createWorkerUrl } from "maligator:workers";

const pool = createPool(createWorkerUrl("../workers/jobs.mjs", import.meta.url), {
	size: 1,
});
await pool.ready;
console.log("idle-pool PASS");
