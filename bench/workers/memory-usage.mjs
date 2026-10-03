import { performance } from "node:perf_hooks";

const count = Number(process.argv[2] ?? "1024");
const live = Number(process.argv[3] ?? "4096");
if (
	!Number.isSafeInteger(count) ||
	count < 1 ||
	count > 100_000 ||
	!Number.isSafeInteger(live) ||
	live < 1 ||
	live > 100_000
)
	throw new Error("invalid memory usage workload");
const retained = Array.from({ length: live }, (_, index) => ({
	index,
	text: "object" + index,
	values: [index, index + 1],
}));
const buffers = Array.from({ length: 256 }, (_, index) =>
	new Uint8Array(4096).fill(index),
);
function sample() {
	const usage = process.memoryUsage();
	if (
		![
			usage.rss,
			usage.heapTotal,
			usage.heapUsed,
			usage.external,
			usage.arrayBuffers,
		].every((value) => Number.isFinite(value) && value >= 0) ||
		usage.rss === 0 ||
		usage.heapUsed === 0 ||
		usage.heapUsed > usage.heapTotal ||
		usage.arrayBuffers > usage.external
	)
		throw new Error("invalid memory accounting");
}
for (let i = 0; i < 64; i++) sample();
const start = performance.now();
for (let i = 0; i < count; i++) sample();
const elapsedMs = performance.now() - start;
for (let i = 0; i < retained.length; i++) {
	const value = retained[i];
	if (value.index !== i || value.text !== "object" + i || value.values[1] !== i + 1)
		throw new Error("retained graph corrupted");
}
for (let i = 0; i < buffers.length; i++)
	if (buffers[i][4095] !== i) throw new Error("retained buffer corrupted");
console.log(
	JSON.stringify({ mode: "memory-usage", operations: count, checksum: live, elapsedMs }),
);
