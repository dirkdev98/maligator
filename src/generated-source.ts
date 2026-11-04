import type { Hash } from "node:crypto";
import { closeSync, openSync, readSync, writeFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const BATCH_CODE_UNITS = 256 * 1024;

/** Decode a source file in bounded chunks, preserving UTF-8 sequences across reads. */
export function* readSourceChunks(file: string): Generator<string> {
	const descriptor = openSync(file, "r");
	const bytes = Buffer.allocUnsafe(BATCH_CODE_UNITS);
	const decoder = new StringDecoder("utf8");
	try {
		for (;;) {
			const length = readSync(descriptor, bytes, 0, bytes.length, null);
			if (length === 0) break;
			const text = decoder.write(bytes.subarray(0, length));
			if (text.length > 0) yield text;
		}
		const tail = decoder.end();
		if (tail.length > 0) yield tail;
	} finally {
		closeSync(descriptor);
	}
}

/** Writes concatenated UTF-16 fragments as UTF-8, optionally hashing those same bytes. */
export function writeSourceChunks(
	file: string | number,
	chunks: Iterable<string>,
	digest?: Hash,
): number {
	const descriptor = typeof file === "number" ? file : openSync(file, "w");
	let parts: Array<string> = [];
	let codeUnits = 0;
	let bytes = 0;
	const flush = (final: boolean): void => {
		let text = parts.length === 1 ? parts[0]! : parts.join("");
		parts = [];
		codeUnits = 0;
		// A surrogate pair may straddle fragments or an encoding batch.
		const last = text.charCodeAt(text.length - 1);
		if (!final && last >= 0xd800 && last <= 0xdbff) {
			parts.push(text.slice(-1));
			codeUnits = 1;
			text = text.slice(0, -1);
		}
		if (text.length === 0) return;
		const buffer = Buffer.from(text);
		digest?.update(buffer);
		writeFileSync(descriptor, buffer);
		bytes += buffer.length;
	};
	try {
		for (const chunk of chunks) {
			let start = 0;
			while (start < chunk.length) {
				const end = Math.min(chunk.length, start + BATCH_CODE_UNITS - codeUnits);
				parts.push(chunk.slice(start, end));
				codeUnits += end - start;
				start = end;
				if (codeUnits === BATCH_CODE_UNITS) flush(false);
			}
		}
		flush(true);
		return bytes;
	} finally {
		if (typeof file === "string") closeSync(descriptor);
	}
}
