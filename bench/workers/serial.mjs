import { performance } from "node:perf_hooks";

const count = Number(process.argv[2] ?? "192");
if (!Number.isSafeInteger(count) || count < 1 || count > 1024)
	throw new Error("invalid serial control workload");
function compute(seed) {
	for (let i = 0; i < 1_000_000; i++) seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
	return seed;
}
let warmup = 0;
for (let i = 0; i < 16; i++) warmup = (warmup + compute(i)) | 0;
const start = performance.now();
let checksum = warmup;
for (let i = 0; i < count; i++) checksum = (checksum + compute(i + 16)) | 0;
console.log(
	JSON.stringify({
		mode: "serial-compute",
		operations: count,
		checksum,
		elapsedMs: performance.now() - start,
	}),
);
