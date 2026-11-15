import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function drainBufferedChunks(objectMode) {
	let reads = 0;
	const source = new Readable({
		objectMode,
		read() {
			reads++;
		},
	});
	const chunks = [];
	let completeWrite;
	const destination = new Writable({
		objectMode,
		highWaterMark: 1,
		write(chunk, encoding, callback) {
			chunks.push(objectMode ? chunk.value : String(chunk));
			completeWrite = callback;
		},
	});
	for (const value of ["first", "second", "third"]) {
		source.push(objectMode ? { value } : value);
	}
	source.pipe(destination);
	await tick();
	assert.deepEqual(chunks, ["first"]);
	assert.equal(reads, 1);
	assert.equal(source.isPaused(), true);
	completeWrite();
	await tick();
	assert.deepEqual(chunks, ["first", "second"]);
	assert.equal(reads, 1);
	completeWrite();
	await tick();
	assert.deepEqual(chunks, ["first", "second", "third"]);
	assert.equal(reads, 1);
	completeWrite();
	await tick();
	assert.equal(source.readableLength, 0);
	assert.equal(reads, 1);
	const finished = new Promise((resolve) => destination.once("finish", resolve));
	source.push(null);
	await finished;
}

await drainBufferedChunks(false);
await drainBufferedChunks(true);
console.log("PASS");
