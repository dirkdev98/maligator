import { Buffer } from "node:buffer";
import {
	createReadStream,
	mkdtempSync,
	writeFileSync,
	rmSync,
	openSync,
	closeSync,
	fstatSync,
} from "node:fs";
import { Readable } from "node:stream";
import { createGunzip, gunzipSync } from "node:zlib";

const results = [];
function check(name, condition) {
	results.push([name, !!condition]);
}
const compressed = Buffer.from(
	"H4sIAAAAAAAAE+3GSw3AIBQAMEUYwM3jD8dlQf98LO2p8dS1b08t3shRautjrn3MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzsD/sADO2HOF3DAAA=",
	"base64",
);
const expected = "archive-data:" + "abcdefghij".repeat(5000);
async function collect(stream) {
	const chunks = [];
	for await (const chunk of stream) chunks.push(chunk);
	return Buffer.concat(chunks);
}
function errorCode(bytes, options) {
	try {
		gunzipSync(bytes, options);
		return "none";
	} catch (error) {
		return error.code;
	}
}
async function run() {
	check("synchronous gzip data", gunzipSync(compressed).toString() === expected);
	check(
		"synchronous exact bound",
		gunzipSync(compressed, { maxOutputLength: expected.length }).length ===
			expected.length,
	);
	check(
		"synchronous overflow code",
		errorCode(compressed, { maxOutputLength: expected.length - 1 }) ===
			"ERR_BUFFER_TOO_LARGE",
	);
	let overflowRange = false;
	try {
		gunzipSync(compressed, { maxOutputLength: 1 });
	} catch (error) {
		overflowRange = error instanceof RangeError;
	}
	check("synchronous overflow is a RangeError", overflowRange);
	check(
		"synchronous truncation code",
		errorCode(compressed.subarray(0, compressed.length - 5)) === "Z_BUF_ERROR",
	);
	check(
		"synchronous corruption code",
		errorCode(Buffer.from([0, 1, 2, 3])) === "Z_DATA_ERROR",
	);
	check(
		"concatenated gzip members",
		gunzipSync(Buffer.concat([compressed, compressed])).length === expected.length * 2,
	);
	const scalarChunks = [];
	for await (const chunk of Readable.from("whole")) scalarChunks.push(chunk);
	check(
		"string source yields one chunk",
		scalarChunks.length === 1 && scalarChunks[0] === "whole",
	);
	const bufferChunks = [];
	for await (const chunk of Readable.from(Buffer.from("whole"))) bufferChunks.push(chunk);
	check(
		"buffer source yields one chunk",
		bufferChunks.length === 1 && bufferChunks[0].toString() === "whole",
	);
	const iterable = {
		async *[Symbol.asyncIterator]() {
			yield Promise.resolve(Buffer.from("a"));
			yield Buffer.from("bc");
		},
	};
	check(
		"async source and promised values",
		(await collect(Readable.from(iterable))).toString() === "abc",
	);
	let returned = false;
	const source = {
		[Symbol.asyncIterator]() {
			let index = 0;
			return {
				async next() {
					return { value: Buffer.from(String(index++)), done: false };
				},
				async return() {
					returned = true;
					return { done: true };
				},
			};
		},
	};
	for await (const chunk of Readable.from(source)) {
		check("async source first chunk", chunk.toString() === "0");
		break;
	}
	check("early iteration closes source", returned);
	const cleanupError = new Error("cleanup");
	const rejecting = {
		[Symbol.asyncIterator]() {
			return {
				async next() {
					return { value: Buffer.from("x"), done: false };
				},
				async return() {
					throw cleanupError;
				},
			};
		},
	};
	const rejectingStream = Readable.from(rejecting);
	let cleanupEmitted = false;
	rejectingStream.on("error", () => {
		cleanupEmitted = true;
	});
	const iterator = rejectingStream[Symbol.asyncIterator]();
	await iterator.next();
	let rejected = false;
	try {
		await iterator.return();
	} catch (error) {
		rejected = error === cleanupError;
	}
	await new Promise((resolve) =>
		rejectingStream.closed ? resolve() : rejectingStream.once("close", resolve),
	);
	check("cleanup rejection settles iterator return", !rejected && cleanupEmitted);
	const inputError = new Error("input");
	const failing = {
		async *[Symbol.asyncIterator]() {
			yield Buffer.from("a");
			throw inputError;
		},
	};
	rejected = false;
	try {
		await collect(Readable.from(failing));
	} catch (error) {
		rejected = error === inputError;
	}
	check("async input error preserves identity", rejected);
	const chunks = [];
	const input = Readable.from({
		async *[Symbol.asyncIterator]() {
			yield compressed;
		},
	});
	const gunzip = createGunzip({ chunkSize: 1024, readableHighWaterMark: 2048 });
	input.on("error", (error) => gunzip.destroy(error));
	for await (const chunk of input.pipe(gunzip)) chunks.push(chunk);
	check("streamed gzip content", Buffer.concat(chunks).toString() === expected);
	check(
		"streamed gzip output is chunk bounded",
		chunks.length > 10 && chunks.every((chunk) => chunk.length <= 1024),
	);
	const concurrent = Readable.from([Buffer.from("first"), Buffer.from("second")])[
		Symbol.asyncIterator
	]();
	const concurrentValues = await Promise.all([concurrent.next(), concurrent.next()]);
	check(
		"concurrent iterator requests keep ordering",
		concurrentValues[0].value.toString() === "first" &&
			concurrentValues[1].value.toString() === "second",
	);
	await concurrent.return();
	let streamCorruption = "";
	try {
		await collect(Readable.from([Buffer.from([0, 1, 2, 3])]).pipe(createGunzip()));
	} catch (error) {
		streamCorruption = error.code;
	}
	check("streamed corruption code", streamCorruption === "Z_DATA_ERROR");
	const forwardingError = new Error("source pipeline");
	const failingInput = Readable.from({
		async *[Symbol.asyncIterator]() {
			yield compressed.subarray(0, 30);
			throw forwardingError;
		},
	});
	const failingGunzip = createGunzip({ chunkSize: 256, readableHighWaterMark: 512 });
	failingInput.on("error", (error) => failingGunzip.destroy(error));
	let forwarded = false;
	try {
		await collect(failingInput.pipe(failingGunzip));
	} catch (error) {
		forwarded = error === forwardingError;
	}
	check("pipeline source rejection reaches async consumer", forwarded);
	let truncated = "";
	try {
		await collect(
			Readable.from([compressed.subarray(0, compressed.length - 4)]).pipe(
				createGunzip({ chunkSize: 512, readableHighWaterMark: 1024 }),
			),
		);
	} catch (error) {
		truncated = error.code;
	}
	check("streamed truncation code", truncated === "Z_BUF_ERROR");
	const dir = mkdtempSync("/tmp/mal-upm-archive-");
	try {
		const path = dir + "/file";
		writeFileSync(path, expected);
		const file = createReadStream(path, { highWaterMark: 997 });
		const fileChunks = [];
		for await (const chunk of file) fileChunks.push(chunk);
		check(
			"file stream bounded chunks and content",
			fileChunks.length > 10 &&
				fileChunks.every((chunk) => chunk.length <= 997) &&
				Buffer.concat(fileChunks).toString() === expected,
		);
		check("file stream closes at eof", file.closed && file.fd === null);
		const events = [];
		const eventFile = createReadStream(path, { highWaterMark: 401 });
		const eventChunks = [];
		eventFile.on("data", (chunk) => eventChunks.push(chunk));
		eventFile.on("end", () => events.push("end"));
		await new Promise((resolve, reject) => {
			eventFile.on("error", reject);
			eventFile.on("close", () => {
				events.push("close");
				resolve();
			});
		});
		check(
			"file data events are bounded and end precedes close",
			eventChunks.length > 10 &&
				eventChunks.every((chunk) => chunk.length <= 401) &&
				Buffer.concat(eventChunks).toString() === expected &&
				events.join("|") === "end|close",
		);
		check(
			"file stream range",
			(
				await collect(createReadStream(path, { start: 3, end: 10, highWaterMark: 3 }))
			).toString() === expected.slice(3, 11),
		);
		const early = createReadStream(path, { highWaterMark: 4 });
		let earlyFd = -1;
		for await (const chunk of early) {
			earlyFd = early.fd;
			break;
		}
		await new Promise((resolve) =>
			early.closed ? resolve() : early.once("close", resolve),
		);
		let closed = false;
		try {
			fstatSync(earlyFd);
		} catch (error) {
			closed = error.code === "EBADF";
		}
		check("early file exit closes descriptor", early.closed && closed);
		const fd = openSync(path, "r");
		await collect(
			createReadStream(path, {
				fd: new Float64Array([fd])[0],
				autoClose: false,
				highWaterMark: 1234,
			}),
		);
		check("caller owned descriptor survives eof", fstatSync(fd).isFile());
		closeSync(fd);
		let missing = "";
		try {
			await collect(createReadStream(dir + "/missing"));
		} catch (error) {
			missing = error.code;
		}
		check("file stream open error", missing === "ENOENT");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
run().then(
	() => {
		for (const [name, passed] of results)
			console.log((passed ? "PASS " : "FAIL: ") + name);
		console.log("RESULT " + results.filter((x) => x[1]).length + "/" + results.length);
	},
	(error) => {
		console.log("FAIL: unexpected " + error.stack);
		console.log("RESULT 0/1");
	},
);
