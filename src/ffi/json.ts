import type { Buffer } from "node:buffer";
import { FfiError } from "./ffi-error.ts";
import { FfiText } from "./text.ts";

type JsonObject = Record<string, unknown>;

/** Decode JSON from bytes without materializing an aggregate engine string. */
export class FfiJsonReader {
	readonly data: Buffer;
	readonly label: string;
	constructor(data: Buffer, label = "FFI JSON") {
		this.data = data;
		this.label = label;
	}
	malformed(offset: number): never {
		throw new FfiError(`invalid ${this.label} near byte ${offset}`);
	}
	read(): unknown {
		const start = this.whitespace(0);
		const decoded = this.value(start);
		if (this.whitespace(decoded.end) !== this.data.length)
			return this.malformed(decoded.end);
		return decoded.value;
	}
	whitespace(offset: number): number {
		const data = this.data;
		while (offset < data.length) {
			const byte = data[offset];
			if (byte !== 32 && byte !== 9 && byte !== 10 && byte !== 13) break;
			offset++;
		}
		return offset;
	}

	private stringEnd(offset: number): number {
		return this.scanStringEnd(offset, this.data.length) ?? this.malformed(offset);
	}

	private scanStringEnd(offset: number, limit: number): number | undefined {
		const data = this.data;
		for (let index = offset + 1; index < limit; index++) {
			const byte = data[index];
			if (byte === 34) return index + 1;
			if (byte === 92) index++;
		}
		return undefined;
	}

	private containerEnd(offset: number, limit: number): number | undefined {
		const data = this.data;
		const closes: Array<number> = [];
		for (let index = offset; index < limit; index++) {
			const byte = data[index];
			if (byte === 34) {
				const end = this.scanStringEnd(index, limit);
				if (end === undefined) return undefined;
				index = end - 1;
			} else if (byte === 123) closes.push(125);
			else if (byte === 91) closes.push(93);
			else if (byte === 125 || byte === 93) {
				if (closes.pop() !== byte) return this.malformed(index);
				if (closes.length === 0) return index + 1;
			}
		}
		return undefined;
	}

	value(start: number): { value: unknown; end: number } {
		const data = this.data;
		const first = data[start];
		if (first === 123 || first === 91) {
			// Bound lookahead so decoding a large child never scans its whole subtree again.
			const end = this.containerEnd(start, Math.min(data.length, start + 256 * 1024));
			if (end === undefined) return this.container(start);
			return { value: this.parse(start, end), end };
		}
		if (first === 34) {
			const end = this.stringEnd(start);
			return { value: this.parse(start, end), end };
		}
		let end = start;
		while (end < data.length) {
			const byte = data[end];
			if (
				byte === 44 ||
				byte === 125 ||
				byte === 93 ||
				byte === 32 ||
				byte === 9 ||
				byte === 10 ||
				byte === 13
			)
				break;
			end++;
		}
		if (end === start) return this.malformed(start);
		return { value: this.parse(start, end), end };
	}

	private container(start: number): { value: unknown; end: number } {
		const data = this.data;
		const object = data[start] === 123;
		const close = object ? 125 : 93;
		const result: JsonObject | Array<unknown> = object ? {} : [];
		let offset = this.whitespace(start + 1);
		if (data[offset] !== close) {
			for (;;) {
				let key: string | undefined;
				if (object) {
					if (data[offset] !== 34) return this.malformed(offset);
					const keyEnd = this.stringEnd(offset);
					const name = this.parse(offset, keyEnd);
					if (typeof name !== "string") return this.malformed(offset);
					key = name;
					offset = this.whitespace(keyEnd);
					if (data[offset] !== 58) return this.malformed(offset);
					offset = this.whitespace(offset + 1);
				}
				const decoded = this.value(offset);
				if (Array.isArray(result)) result.push(decoded.value);
				else
					Object.defineProperty(result, key!, {
						value: decoded.value,
						enumerable: true,
						configurable: true,
						writable: true,
					});
				offset = this.whitespace(decoded.end);
				if (data[offset] === close) break;
				if (data[offset] !== 44) return this.malformed(offset);
				offset = this.whitespace(offset + 1);
			}
		}
		return { value: result, end: offset + 1 };
	}

	private parse(start: number, end: number): unknown {
		const data = this.data;
		if (end - start > 256 * 1024 && data[start] === 34) {
			const parts: Array<string> = [];
			let begin = start + 1;
			let offset = begin;
			while (offset < end - 1) {
				const byte = data[offset]!;
				const next =
					offset +
					(byte === 92
						? data[offset + 1] === 117
							? 6
							: 2
						: byte >= 0xf0
							? 4
							: byte >= 0xe0
								? 3
								: byte >= 0xc0
									? 2
									: 1);
				if (next > end - 1) return this.malformed(offset);
				offset = next;
				if (offset - begin >= 256 * 1024 || offset === end - 1) {
					try {
						parts.push(JSON.parse(`"${data.toString("utf8", begin, offset)}"`) as string);
					} catch {
						return this.malformed(begin);
					}
					begin = offset;
				}
			}
			return new FfiText(parts);
		}

		try {
			return JSON.parse(data.toString("utf8", start, end));
		} catch (error) {
			throw new FfiError(
				`cannot decode ${this.label} at byte ${start}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

/** Standard JSON on the wire, including text that cannot fit one engine string. */
export function* ffiJsonChunks(
	value: unknown,
	indent = "",
	depth = 0,
): Generator<string> {
	if (value instanceof FfiText) {
		yield '"';
		for (const chunk of value.chunks) yield JSON.stringify(chunk).slice(1, -1);
		yield '"';
		return;
	}
	if (typeof value === "bigint") {
		yield* ffiJsonChunks({ $bigint: value.toString() }, indent, depth);
		return;
	}
	if (typeof value !== "object" || value === null) {
		const encoded = JSON.stringify(value);
		if (encoded === undefined)
			throw new FfiError("cannot encode an unsupported FFI JSON value");
		yield encoded;
		return;
	}
	const array = Array.isArray(value);
	const entries: ReadonlyArray<readonly [string, unknown]> = array
		? Array.from(
				value as ReadonlyArray<unknown>,
				(child, index) => [String(index), child] as const,
			)
		: Object.entries(value).filter(([, child]) => child !== undefined);
	yield array ? "[" : "{";
	for (let index = 0; index < entries.length; index++) {
		if (index > 0) yield ",";
		if (indent !== "") yield `\n${indent.repeat(depth + 1)}`;
		const [key, child] = entries[index]!;
		if (!array) yield `${JSON.stringify(key)}:${indent === "" ? "" : " "}`;
		yield* ffiJsonChunks(child === undefined ? null : child, indent, depth + 1);
	}
	if (indent !== "" && entries.length > 0) yield `\n${indent.repeat(depth)}`;
	yield array ? "]" : "}";
}

export function reviveFfiJson(value: unknown): unknown {
	if (value instanceof FfiText || value === null || typeof value !== "object")
		return value;
	if ("$bigint" in value && typeof value.$bigint === "string")
		return BigInt(value.$bigint);
	for (const [key, child] of Object.entries(value)) {
		Reflect.set(
			value,
			key,
			key === "doc" && typeof child === "string"
				? new FfiText([child])
				: reviveFfiJson(child),
		);
	}
	return value;
}

export function ffiJsonEqual(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (left instanceof FfiText || right instanceof FfiText) {
		if (
			!(left instanceof FfiText || typeof left === "string") ||
			!(right instanceof FfiText || typeof right === "string")
		)
			return false;
		const a = typeof left === "string" ? new FfiText([left]) : left;
		const b = typeof right === "string" ? new FfiText([right]) : right;
		if (a.length !== b.length) return false;
		let i = 0,
			j = 0,
			x = 0,
			y = 0;
		while (i < a.chunks.length && j < b.chunks.length) {
			const count = Math.min(a.chunks[i]!.length - x, b.chunks[j]!.length - y);
			if (a.chunks[i]!.slice(x, x + count) !== b.chunks[j]!.slice(y, y + count))
				return false;
			x += count;
			y += count;
			if (x === a.chunks[i]!.length) {
				i++;
				x = 0;
			}
			if (y === b.chunks[j]!.length) {
				j++;
				y = 0;
			}
		}
		return true;
	}
	if (
		left === null ||
		right === null ||
		typeof left !== "object" ||
		typeof right !== "object" ||
		Array.isArray(left) !== Array.isArray(right)
	)
		return false;
	const a = Object.keys(left),
		b = Object.keys(right);
	return (
		a.length === b.length &&
		a.every(
			(key) =>
				Object.hasOwn(right, key) &&
				ffiJsonEqual(Reflect.get(left, key), Reflect.get(right, key)),
		)
	);
}
