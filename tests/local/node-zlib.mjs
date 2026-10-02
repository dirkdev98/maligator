import { Transform } from "node:stream";
import zlib, {
	constants,
	createBrotliDecompress,
	createGunzip,
	createGzip,
	createInflate,
	deflate,
} from "node:zlib";
import bareZlib from "zlib";

let passed = 0;
let total = 0;

function check(condition, name) {
	total++;
	if (condition) passed++;
	else console.log("FAIL: " + name);
}

async function decode(factory, encoded, splits) {
	const stream = factory();
	const chunks = [];
	let error;
	stream.on("data", (chunk) => chunks.push(chunk));
	stream.on("error", (value) => {
		error = value;
	});
	let offset = 0;
	for (const size of splits) {
		stream.write(Buffer.from(encoded.slice(offset, offset + size)));
		offset += size;
	}
	stream.end(Buffer.from(encoded.slice(offset)));
	for (let i = 0; i < 12; i++) await Promise.resolve();
	return { stream, error, output: Buffer.concat(chunks).toString() };
}

async function main() {
	check(
		bareZlib === zlib &&
			zlib.constants === constants &&
			zlib.createInflate === createInflate &&
			zlib.createGunzip === createGunzip &&
			zlib.createBrotliDecompress === createBrotliDecompress &&
			zlib.createGzip === createGzip &&
			zlib.deflate === deflate,
		"canonical bare/node identity",
	);
	check(
		Object.keys(zlib).sort().join(",") ===
			"constants,createBrotliDecompress,createGunzip,createGzip,createInflate,deflate,gunzipSync",
		"declared compatibility exports",
	);
	check(
		constants.Z_SYNC_FLUSH === 2 &&
			constants.BROTLI_OPERATION_FLUSH === 1 &&
			constants.ZSTD_e_flush === 1,
		"portable flush constants",
	);
	let compressionFailures = 0;
	for (const operation of [createGzip, deflate]) {
		try {
			operation();
		} catch (error) {
			if (error instanceof Error && error.message.includes("not supported")) {
				compressionFailures++;
			}
		}
	}
	check(compressionFailures === 2, "unsupported compression fails explicitly");

	const text = "bounded streaming output; split input; portable codecs";
	const deflateBytes = [
		120, 156, 75, 202, 47, 205, 75, 73, 77, 81, 40, 46, 41, 74, 77, 204, 205, 204, 75, 87,
		200, 47, 45, 41, 40, 45, 177, 86, 40, 46, 200, 201, 44, 81, 200, 204, 3, 115, 10, 242,
		139, 74, 18, 147, 114, 82, 21, 146, 243, 83, 82, 147, 139, 1, 62, 238, 20, 185,
	];
	const brotli = [
		27, 53, 0, 0, 140, 84, 181, 191, 28, 75, 115, 171, 157, 57, 240, 144, 133, 220, 205,
		21, 13, 216, 1, 27, 171, 109, 88, 216, 152, 147, 124, 163, 97, 107, 213, 148, 222, 36,
		4, 164, 156,
	];
	const gzip = [
		31, 139, 8, 0, 0, 0, 0, 0, 0, 19, 75, 204, 41, 200, 72, 4, 0, 106, 57, 224, 208, 5, 0,
		0, 0, 31, 139, 8, 0, 0, 0, 0, 0, 0, 19, 75, 74, 45, 73, 4, 0, 99, 4, 145, 143, 4, 0,
		0, 0,
	];

	const inflated = await decode(createInflate, deflateBytes, [1, 2, 5, 7]);
	check(
		inflated.stream instanceof Transform && !inflated.error && inflated.output === text,
		"split zlib stream",
	);
	const gunzipped = await decode(createGunzip, gzip, [3, 4, 11, 9]);
	check(
		gunzipped.stream instanceof Transform &&
			!gunzipped.error &&
			gunzipped.output === "alphabeta",
		"split concatenated gzip members",
	);
	const decompressed = await decode(createBrotliDecompress, brotli, [2, 3, 8]);
	check(
		decompressed.stream instanceof Transform &&
			!decompressed.error &&
			decompressed.output === text,
		"split Brotli stream",
	);
	const malformed = await decode(createInflate, [1, 2, 3, 4], [2]);
	check(malformed.error instanceof Error, "malformed input emits an error");
	const truncated = await decode(createBrotliDecompress, brotli.slice(0, -2), [5, 7]);
	check(truncated.error instanceof Error, "truncated input emits an error");

	const lifetimeGzip = [
		31, 139, 8, 0, 0, 0, 0, 0, 0, 19, 237, 198, 49, 17, 0, 32, 12, 4, 48, 69, 149, 197,
		212, 129, 14, 95, 255, 248, 224, 146, 41, 125, 38, 117, 55, 179, 169, 118, 119, 119,
		119, 119, 119, 119, 119, 119, 119, 119, 247, 47, 254, 0, 159, 228, 103, 164, 0, 24, 0,
		0,
	];
	const buffered = createGunzip({ chunkSize: 64, readableHighWaterMark: 128 });
	let writeCompleted = 0;
	buffered.write(Buffer.from(lifetimeGzip), () => writeCompleted++);
	buffered.end();
	const retained = [];
	for await (const chunk of buffered) {
		retained.push(chunk);
		await Promise.resolve();
	}
	check(
		Buffer.concat(retained).toString() === "kept-output-".repeat(512) &&
			writeCompleted === 1 &&
			retained.every((chunk) => chunk.length <= 128),
		"paused decoder retains input, callback and output across collections",
	);

	const reentrant = createGunzip({ chunkSize: 64, readableHighWaterMark: 128 });
	const reentrantChunks = [];
	const reentrantDone = new Promise((resolve, reject) => {
		reentrant.on("error", reject);
		reentrant.on("end", resolve);
	});
	reentrant.on("data", (chunk) => reentrantChunks.push(chunk));
	reentrant.write(Buffer.from(gzip.slice(0, 25)), () =>
		reentrant.end(Buffer.from(gzip.slice(25))),
	);
	await reentrantDone;
	check(
		Buffer.concat(reentrantChunks).toString() === "alphabeta",
		"write callback can enqueue the next gzip member",
	);

	const cancelled = createGunzip({ chunkSize: 64, readableHighWaterMark: 128 });
	const cancellation = new Error("cancel inflate from data");
	let cancelledChunks = 0;
	let cancelledError;
	const closed = new Promise((resolve) => cancelled.on("close", resolve));
	cancelled.on("error", (error) => (cancelledError = error));
	cancelled.on("data", () => {
		cancelledChunks++;
		cancelled.destroy(cancellation);
	});
	cancelled.end(Buffer.from(lifetimeGzip));
	await closed;
	check(
		cancelledChunks === 1 && cancelledError === cancellation,
		"destroy from a pushed chunk preserves error identity and stops pumping",
	);

	console.log("RESULT " + passed + "/" + total);
}

main();
