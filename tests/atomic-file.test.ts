import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { expect, test } from "vitest";
import { writeFileAtomically } from "../src/atomic-file.ts";

test("same-process workers publish complete cache records without sharing temporary files", async () => {
	const directory = mkdtempSync(path.join(tmpdir(), "mal-atomic-publish-"));
	const destination = path.join(directory, "manifest.json");
	const barrier = new SharedArrayBuffer(4);
	const state = new Int32Array(barrier);
	const workers: Array<Worker> = [];
	try {
		const ready: Array<Promise<void>> = [];
		const completed = Array.from({ length: 4 }, (_, writer) => {
			const worker = new Worker(
				new URL("./fixtures/atomic-file-worker.mts", import.meta.url),
				{
					workerData: { destination, barrier, writer },
				},
			);
			workers.push(worker);
			ready.push(
				new Promise<void>((resolve, reject) => {
					worker.once("message", () => resolve());
					worker.once("error", reject);
				}),
			);
			return new Promise<void>((resolve, reject) => {
				worker.once("error", reject);
				worker.once("exit", (code) => {
					if (code === 0) resolve();
					else reject(new Error(`publisher exited with ${code}`));
				});
			});
		});
		await Promise.all([
			Promise.all(ready).then(() => {
				Atomics.store(state, 0, 1);
				Atomics.notify(state, 0);
			}),
			Promise.all(completed),
		]);
		const record = JSON.parse(readFileSync(destination, "utf8")) as {
			writer: number;
			iteration: number;
			payload: string;
		};
		expect(record.iteration).toBe(31);
		expect(record.payload).toBe(String(record.writer).repeat(64 * 1024));
		expect(readdirSync(directory)).toEqual(["manifest.json"]);
	} finally {
		await Promise.all(workers.map((worker) => worker.terminate()));
		rmSync(directory, { recursive: true, force: true });
	}
});

test("failed publication removes its temporary file", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "mal-atomic-failure-"));
	const destination = path.join(directory, "existing-directory");
	mkdirSync(destination);
	try {
		expect(() => writeFileAtomically(destination, "bytes")).toThrow();
		expect(readdirSync(directory)).toEqual(["existing-directory"]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
