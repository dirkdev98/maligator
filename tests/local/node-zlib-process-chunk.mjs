import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { once } from "node:events";
import {
	constants,
	createGzip,
	createGunzip,
	createInflate,
	deflateSync,
	gzipSync,
	gunzipSync,
} from "node:zlib";

const selection = process.env.MAL_TEST_ZLIB_PROCESS_CASE;
const input = Buffer.from(
	"streaming codecs keep their state across chunks\n".repeat(2000),
);
const compressed = gzipSync(input);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function retainedChunk(engine, chunk, flush) {
	const handle = engine._handle;
	const close = handle.close;
	handle.close = () => {};
	try {
		const result = engine._processChunk(chunk, flush);
		assert.equal(engine._handle, null);
		return Buffer.from(result);
	} finally {
		engine._handle = handle;
		handle.close = close;
	}
}

if (selection === "sync") {
	const encoder = createGzip({ chunkSize: 64 });
	const encoded = encoder._processChunk(input, constants.Z_FINISH);
	assert.deepEqual(gunzipSync(encoded), input);
	assert.equal(encoder.bytesWritten, input.length);
	assert.equal(encoder._closed, true);
	const decoder = createGunzip({ chunkSize: 64 });
	assert.deepEqual(decoder._processChunk(compressed, constants.Z_FINISH), input);
	assert.equal(decoder.bytesWritten, compressed.length);
	assert.equal(decoder._closed, true);
	const deflated = deflateSync(input);
	const withTrailing = Buffer.concat([deflated, Buffer.from("trailing")]);
	const inflater = createInflate();
	assert.deepEqual(inflater._processChunk(withTrailing, constants.Z_FINISH), input);
	assert.equal(inflater.bytesWritten, deflated.length);
} else if (selection === "retained") {
	const encoder = createGzip();
	const output = [];
	for (let offset = 0; offset < input.length; offset += 15000) {
		const chunk = input.subarray(offset, offset + 15000);
		output.push(retainedChunk(encoder, chunk, constants.Z_NO_FLUSH));
		assert.equal(encoder.bytesWritten, chunk.length);
		assert.equal(encoder._closed, false);
	}
	output.push(retainedChunk(encoder, Buffer.alloc(0), constants.Z_FINISH));
	assert.deepEqual(gunzipSync(Buffer.concat(output)), input);
	const encoderClosed = once(encoder, "close");
	encoder.close();
	await encoderClosed;
	assert.equal(encoder._closed, true);
	const decoder = createGunzip();
	const decoded = [];
	const split = Math.ceil(compressed.length / 4);
	for (let offset = 0; offset < compressed.length; offset += split)
		decoded.push(
			retainedChunk(
				decoder,
				compressed.subarray(offset, offset + split),
				constants.Z_NO_FLUSH,
			),
		);
	decoded.push(retainedChunk(decoder, Buffer.alloc(0), constants.Z_FINISH));
	assert.deepEqual(Buffer.concat(decoded), input);
	const decoderClosed = once(decoder, "close");
	decoder.close();
	await decoderClosed;
} else if (selection === "errors") {
	for (const [bytes, options, code] of [
		[Buffer.from("bad"), {}, "Z_DATA_ERROR"],
		[compressed.subarray(0, compressed.length - 2), {}, "Z_BUF_ERROR"],
		[compressed, { maxOutputLength: 10 }, "ERR_BUFFER_TOO_LARGE"],
	]) {
		const decoder = createGunzip(options);
		assert.throws(() => decoder._processChunk(bytes, constants.Z_FINISH), { code });
		assert.equal(decoder._closed, true);
	}
} else if (selection === "async") {
	const storage = new AsyncLocalStorage();
	const decoder = storage.run("compression", () =>
		createGunzip({ chunkSize: 64, readableHighWaterMark: 64 }),
	);
	const handle = decoder._handle;
	let called = false;
	let returned = false;
	const readable = once(decoder, "readable");
	const completed = storage.run(
		"caller",
		() =>
			new Promise((resolve, reject) => {
				const result = decoder._processChunk(
					compressed,
					constants.Z_FINISH,
					function (error) {
						try {
							assert.equal(returned, true);
							assert.equal(error, undefined);
							assert.equal(this, handle);
							assert.equal(storage.getStore(), "compression");
							called = true;
							resolve();
						} catch (failure) {
							reject(failure);
						}
					},
				);
				assert.equal(result, undefined);
			}),
	);
	returned = true;
	await readable;
	assert.equal(called, false);
	await delay(5);
	assert.equal(called, false);
	const output = [];
	decoder.on("data", (chunk) => output.push(chunk));
	decoder.resume();
	await completed;
	const ended = once(decoder, "end");
	decoder.end();
	await ended;
	assert.deepEqual(Buffer.concat(output), input);
} else if (selection === "async-trailing") {
	const decoder = createInflate();
	const deflated = deflateSync(input);
	const output = [];
	decoder.on("data", (chunk) => output.push(chunk));
	const ended = once(decoder, "end");
	const completed = new Promise((resolve) => {
		decoder._processChunk(
			Buffer.concat([deflated, Buffer.from("trailing")]),
			constants.Z_FINISH,
			resolve,
		);
	});
	await Promise.all([ended, completed]);
	assert.equal(decoder.bytesWritten, deflated.length);
	assert.deepEqual(Buffer.concat(output), input);
} else if (selection === "destroy") {
	const decoder = createGunzip({ chunkSize: 64, readableHighWaterMark: 64 });
	let count = 0;
	const completed = new Promise((resolve) => {
		decoder._processChunk(compressed, constants.Z_FINISH, () => {
			count++;
			resolve();
		});
	});
	const closed = once(decoder, "close");
	decoder.destroy();
	await Promise.all([completed, closed]);
	await delay(5);
	assert.equal(count, 1);
	assert.equal(decoder._closed, true);
} else if (selection === "async-error") {
	const decoder = createGunzip();
	let error;
	let called = false;
	decoder.on("error", (failure) => {
		error = failure;
	});
	const closed = new Promise((resolve) => decoder.on("close", resolve));
	decoder._processChunk(Buffer.from("bad"), constants.Z_FINISH, () => {
		called = true;
	});
	await closed;
	assert.equal(error.code, "Z_DATA_ERROR");
	assert.equal(called, false);
} else {
	throw new Error(`Unknown case: ${selection}`);
}
console.log("PROCESS CHUNK PASS");
