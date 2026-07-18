import { Transform } from "node:stream";
import zlib, { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
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
			zlib.createInflate === createInflate &&
			zlib.createGunzip === createGunzip &&
			zlib.createBrotliDecompress === createBrotliDecompress,
		"canonical bare/node identity",
	);
	check(
		Object.keys(zlib).sort().join(",") ===
			"createBrotliDecompress,createGunzip,createInflate",
		"decompression-only exports",
	);

	const text = "bounded streaming output; split input; portable codecs";
	const deflate = [
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

	const inflated = await decode(createInflate, deflate, [1, 2, 5, 7]);
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

	console.log("RESULT " + passed + "/" + total);
}

main();
