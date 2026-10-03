import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

const out = [];
const log = (label, value) => out.push(`${label}: ${JSON.stringify(value)}`);
const errorName = (run) => {
	try {
		run();
		return "none";
	} catch (error) {
		return error.constructor.name;
	}
};

// Buffer.from(sab) aliases the shared bytes; custom methods read and write through it.
{
	const sab = new SharedArrayBuffer(8);
	const view = new Uint8Array(sab);
	const buf = Buffer.from(sab);
	buf.writeUInt32BE(0x01020304, 0);
	buf.writeUInt16BE(0x0506, 4);
	log("buffer-alias", [
		Array.from(view),
		buf.readUInt32BE(0),
		buf.readUInt16LE(4),
		buf.toString("hex", 0, 6),
	]);
	const copy = Buffer.alloc(4);
	buf.copy(copy, 0, 1, 5);
	log("buffer-copy", [
		Array.from(copy),
		Buffer.compare(buf.subarray(0, 2), Buffer.from([1, 2])),
		buf.equals(Buffer.from([1, 2, 3, 4, 5, 6, 0, 0])),
		Buffer.concat([buf.subarray(0, 2), copy]).toString("hex"),
	]);
	buf.write("ok", 6, "latin1");
	log("buffer-write", [view[6], view[7]]);
}

// TextDecoder and encodeInto accept [AllowShared] views.
{
	const sab = new SharedArrayBuffer(6);
	new Uint8Array(sab).set([0xe2, 0x82, 0xac, 0x41, 0x42, 0x43]);
	const decoder = new TextDecoder();
	const whole = decoder.decode(new Uint8Array(sab));
	const streamed =
		decoder.decode(new Uint8Array(sab, 0, 2), { stream: true }) +
		decoder.decode(new Uint8Array(sab, 2, 4));
	log("text-decoder", [whole, streamed]);
	const target = new Uint8Array(new SharedArrayBuffer(4));
	const result = new TextEncoder().encodeInto("hé", target);
	log("encode-into", [result.read, result.written, Array.from(target)]);
}

{
	const sab = new SharedArrayBuffer(3);
	new Uint8Array(sab).set([97, 98, 99]);
	const shared = new Uint8Array(sab);
	log("crypto", [
		createHash("sha256").update(shared).digest("hex") ===
			createHash("sha256").update("abc").digest("hex"),
		timingSafeEqual(shared, Buffer.from("abc")),
	]);
}

{
	const dir = mkdtempSync(join(tmpdir(), "mal-sab-consumers-"));
	try {
		const file = join(dir, "data");
		const source = new Uint8Array(new SharedArrayBuffer(4));
		source.set([1, 2, 3, 4]);
		let fd = openSync(file, "w");
		writeSync(fd, source, 1, 3);
		closeSync(fd);
		const target = new Uint8Array(new SharedArrayBuffer(4));
		fd = openSync(file, "r");
		const count = readSync(fd, target, 1, 3, 0);
		closeSync(fd);
		log("fs", [count, Array.from(target)]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

{
	const sab = new SharedArrayBuffer(3);
	new Uint8Array(sab).set([0xe2, 0x82, 0xac]);
	const decoder = new StringDecoder("utf8");
	log(
		"string-decoder",
		decoder.write(new Uint8Array(sab, 0, 1)) +
			decoder.write(new Uint8Array(sab, 1, 2)) +
			decoder.end(),
	);
}

// Stream views are ArrayBufferView without [AllowShared].
{
	let enqueue = "unset";
	new ReadableStream({
		type: "bytes",
		start(controller) {
			enqueue = errorName(() =>
				controller.enqueue(new Uint8Array(new SharedArrayBuffer(2))),
			);
		},
	});
	const reader = new ReadableStream({ type: "bytes" }).getReader({ mode: "byob" });
	let read;
	try {
		await reader.read(new Uint8Array(new SharedArrayBuffer(4)));
		read = "none";
	} catch (error) {
		read = error.constructor.name;
	}
	log("stream-shared-view", [enqueue, read]);
}

// A shared backing is counted once in arrayBuffers however many wrappers alias it.
{
	const size = 1 << 20;
	const before = process.memoryUsage().arrayBuffers;
	const sab = new SharedArrayBuffer(size);
	const after = process.memoryUsage().arrayBuffers;
	const alias = structuredClone(sab);
	const aliased = process.memoryUsage().arrayBuffers;
	log("memory-usage", [after - before >= size, aliased - after < size, alias.byteLength]);
}

console.log(out.join("\n"));
