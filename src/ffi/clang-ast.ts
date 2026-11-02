import type { Buffer } from "node:buffer";
import { FfiError } from "./ffi-error.ts";

type JsonObject = Record<string, unknown>;

function malformed(offset: number): never {
	throw new FfiError(`clang produced invalid AST JSON near byte ${offset}`);
}

function whitespace(data: Buffer, offset: number): number {
	while (offset < data.length) {
		const byte = data[offset];
		if (byte !== 32 && byte !== 9 && byte !== 10 && byte !== 13) break;
		offset++;
	}
	return offset;
}

function stringEnd(data: Buffer, offset: number): number {
	for (let index = offset + 1; index < data.length; index++) {
		const byte = data[index];
		if (byte === 34) return index + 1;
		if (byte === 92) index++;
	}
	return malformed(offset);
}

function valueEnd(data: Buffer, offset: number): number {
	const first = data[offset];
	if (first === 34) return stringEnd(data, offset);
	if (first !== 123 && first !== 91) {
		let index = offset;
		while (index < data.length) {
			const byte = data[index];
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
			index++;
		}
		if (index === offset) return malformed(offset);
		return index;
	}
	const closes: Array<number> = [];
	for (let index = offset; index < data.length; index++) {
		const byte = data[index];
		if (byte === 34) index = stringEnd(data, index) - 1;
		else if (byte === 123) closes.push(125);
		else if (byte === 91) closes.push(93);
		else if (byte === 125 || byte === 93) {
			if (closes.pop() !== byte) return malformed(index);
			if (closes.length === 0) return index + 1;
		}
	}
	return malformed(offset);
}

function parse(data: Buffer, start: number, end: number): unknown {
	if (end - start > 256 * 1024 && (data[start] === 123 || data[start] === 91)) {
		const object = data[start] === 123;
		const close = object ? 125 : 93;
		const result: JsonObject | Array<unknown> = object ? {} : [];
		let offset = whitespace(data, start + 1);
		if (data[offset] !== close) {
			for (;;) {
				let key: string | undefined;
				if (object) {
					if (data[offset] !== 34) return malformed(offset);
					const keyEnd = stringEnd(data, offset);
					const name = parse(data, offset, keyEnd);
					if (typeof name !== "string") return malformed(offset);
					key = name;
					offset = whitespace(data, keyEnd);
					if (data[offset] !== 58) return malformed(offset);
					offset = whitespace(data, offset + 1);
				}
				const next = valueEnd(data, offset);
				const value = parse(data, offset, next);
				if (Array.isArray(result)) result.push(value);
				else
					Object.defineProperty(result, key!, {
						value,
						enumerable: true,
						configurable: true,
						writable: true,
					});
				offset = whitespace(data, next);
				if (data[offset] === close) break;
				if (data[offset] !== 44) return malformed(offset);
				offset = whitespace(data, offset + 1);
			}
		}
		if (offset + 1 !== end) return malformed(offset);
		return result;
	}
	try {
		return JSON.parse(data.toString("utf8", start, end));
	} catch (error) {
		throw new FfiError(
			`cannot decode a clang AST value at byte ${start}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function declaration(data: Buffer, start: number, end: number): JsonObject {
	const value = parse(data, start, end);
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return malformed(start);
	return value as JsonObject;
}

/** Decode containers separately so an aggregate AST never becomes one engine string. */
export function visitClangDeclarations(
	data: Buffer,
	visit: (node: JsonObject) => void,
): void {
	let offset = whitespace(data, 0);
	if (data[offset] !== 123) return malformed(offset);
	offset = whitespace(data, offset + 1);
	const keys = new Set<string>();
	let translationUnit = false;
	for (;;) {
		if (data[offset] !== 34) return malformed(offset);
		const keyEnd = stringEnd(data, offset);
		const key = parse(data, offset, keyEnd);
		if (typeof key !== "string" || keys.has(key)) return malformed(offset);
		keys.add(key);
		offset = whitespace(data, keyEnd);
		if (data[offset] !== 58) return malformed(offset);
		offset = whitespace(data, offset + 1);
		if (key === "inner") {
			if (data[offset] !== 91) return malformed(offset);
			offset = whitespace(data, offset + 1);
			if (data[offset] !== 93) {
				for (;;) {
					const end = valueEnd(data, offset);
					visit(declaration(data, offset, end));
					offset = whitespace(data, end);
					if (data[offset] === 93) break;
					if (data[offset] !== 44) return malformed(offset);
					offset = whitespace(data, offset + 1);
				}
			}
			offset++;
		} else {
			const end = valueEnd(data, offset);
			const value = parse(data, offset, end);
			if (key === "kind") {
				if (value !== "TranslationUnitDecl") return malformed(offset);
				translationUnit = true;
			}
			offset = end;
		}
		offset = whitespace(data, offset);
		if (data[offset] === 125) {
			offset = whitespace(data, offset + 1);
			break;
		}
		if (data[offset] !== 44) return malformed(offset);
		offset = whitespace(data, offset + 1);
	}
	if (offset !== data.length || !translationUnit || !keys.has("inner")) malformed(offset);
}

/** Clang's filtered dump concatenates complete JSON declarations without an array. */
export function clangProbeDeclarations(data: Buffer): ReadonlyArray<JsonObject> {
	const nodes: Array<JsonObject> = [];
	let offset = whitespace(data, 0);
	while (offset < data.length) {
		const end = valueEnd(data, offset);
		nodes.push(declaration(data, offset, end));
		offset = whitespace(data, end);
	}
	return nodes;
}
