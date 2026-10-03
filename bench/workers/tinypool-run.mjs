import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

export async function runWorkerPoolBenchmark(createPool) {
	const mode = process.argv[2] ?? "noop";
	const size = Number(process.argv[3] ?? "2");
	const batches = Number(process.argv[4] ?? "32");
	if (!["noop", "transfer", "compute", "allocate", "io"].includes(mode))
		throw new Error("unknown workload");
	if (!Number.isSafeInteger(size) || size < 1 || size > 8)
		throw new Error("worker count must be between one and eight");
	if (!Number.isSafeInteger(batches) || batches < 1 || batches > 1024)
		throw new Error("batch count must be between one and 1024");
	const directory =
		mode === "io" ? mkdtempSync(join(tmpdir(), "mal-worker-bench-")) : undefined;
	const started = performance.now();
	let pool;
	const counter = new SharedArrayBuffer(4);
	let seed = 0;
	const iterations = mode === "compute" ? 1_000_000 : 0;
	const bytes = mode === "transfer" || mode === "compute" || mode === "io" ? 65_536 : 0;
	const allocations = mode === "allocate" ? 32 : 0;
	function expected(value) {
		for (let i = 0; i < iterations; i++)
			value = (Math.imul(value, 1664525) + 1013904223) | 0;
		return value;
	}
	async function batch(count) {
		const tasks = [];
		const buffers = [];
		const seeds = [];
		for (let i = 0; i < count; i++) {
			const current = seed++;
			const buffer =
				bytes === 0 ? undefined : new Uint8Array(bytes).fill(current & 255).buffer;
			if (buffer !== undefined) buffers.push(buffer);
			seeds.push(current);
			tasks.push(
				pool.run(
					{
						seed: current,
						iterations,
						buffer,
						counter,
						allocations,
						outputPath:
							directory === undefined ? undefined : join(directory, String(current)),
					},
					buffer === undefined ? [] : [buffer],
				),
			);
		}
		const results = await Promise.all(tasks);
		if (!buffers.every((buffer) => buffer.byteLength === 0))
			throw new Error("admitted transfer retained sender ownership");
		let checksum = 0;
		for (let i = 0; i < results.length; i++) {
			const result = results[i];
			if (
				result.byteSum !== (seeds[i] & 255) * bytes ||
				result.allocationSum !== allocations * 256 ||
				result.seed !== seeds[i]
			)
				throw new Error("task output mismatch");
			checksum = (checksum + result.checksum) | 0;
		}
		return { results, seeds, checksum };
	}
	try {
		pool = createPool(size);
		await batch(64);
		const startupMs = performance.now() - started;
		const expectedChecksums = [];
		for (let i = 0; i < batches * 32; i++) expectedChecksums.push(expected(seed + i));
		const measurementStart = performance.now();
		let checksum = 0;
		const threadIds = new Set();
		let observed = 0;
		for (let i = 0; i < batches; i++) {
			const completed = await batch(32);
			for (const result of completed.results) {
				if (result.checksum !== expectedChecksums[observed++])
					throw new Error("numeric checksum mismatch");
				if (result.calls < 2) throw new Error("worker was not persistent");
				threadIds.add(result.threadId);
			}
			checksum = (checksum + completed.checksum) | 0;
		}
		const elapsedMs = performance.now() - measurementStart;
		if (Atomics.load(new Int32Array(counter), 0) !== 64 + batches * 32)
			throw new Error("shared counter mismatch");
		const teardownStart = performance.now();
		await pool.close();
		const teardownMs = performance.now() - teardownStart;
		if (directory !== undefined) {
			for (let i = 0; i < seed; i++) {
				const contents = readFileSync(join(directory, String(i)));
				if (contents.length !== bytes || !contents.every((byte) => byte === (i & 255)))
					throw new Error("file payload mismatch");
			}
		}
		console.log(
			JSON.stringify({
				mode,
				workers: size,
				operations: batches * 32,
				checksum,
				threadCount: threadIds.size,
				elapsedMs,
				startupMs,
				teardownMs,
			}),
		);
	} finally {
		try {
			if (pool !== undefined) await pool.close();
		} finally {
			if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
		}
	}
}
