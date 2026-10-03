import { writeFile } from "node:fs/promises";
import { threadId } from "node:worker_threads";

let calls = 0;
const retained = new Array(8);
export default function run({
	seed,
	iterations,
	buffer,
	counter,
	allocations,
	outputPath,
}) {
	let checksum = seed;
	for (let i = 0; i < iterations; i++)
		checksum = (Math.imul(checksum, 1664525) + 1013904223) | 0;
	let byteSum = 0;
	if (buffer !== undefined) {
		const bytes = new Uint8Array(buffer);
		for (let i = 0; i < bytes.length; i++) byteSum += bytes[i];
	}
	let allocationSum = 0;
	for (let i = 0; i < allocations; i++) {
		const rows = Array.from({ length: 256 }, (_, index) => ({
			index,
			seed,
			text: "row" + index,
		}));
		retained[i & 7] = rows;
		for (const row of rows) {
			if (row.seed !== seed || row.text !== "row" + row.index)
				throw new Error("allocation graph corrupted");
			allocationSum++;
		}
	}
	Atomics.add(new Int32Array(counter), 0, 1);
	const result = { seed, checksum, byteSum, allocationSum, threadId, calls: ++calls };
	return outputPath === undefined
		? result
		: writeFile(outputPath, new Uint8Array(buffer)).then(() => result);
}

export function task(context, input) {
	context.throwIfCancelled();
	return run(input);
}
