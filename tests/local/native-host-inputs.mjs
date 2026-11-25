import { Buffer } from "node:buffer";
import { isAbsolute } from "node:path/posix";
import { types } from "node:util";

function read(value) {
	if (!types.isUint8Array(value)) return "other";
	return value[0];
}

function length(value) {
	try {
		isAbsolute(value);
		return value.length;
	} catch {
		return -value.length;
	}
}

function borrowAndWrite(value) {
	const state = { value };
	const bytes = Buffer.alloc(3);
	const same = bytes.fill(42);
	types.isUint8Array(state);
	const encoded = new TextEncoder(state).encodeInto(state.value, bytes);
	return [same === bytes, encoded.read, encoded.written, ...bytes];
}

globalThis.hostRead = read;
globalThis.hostLength = length;
console.log(
	JSON.stringify([
		read(new Uint8Array([231])),
		read(new Uint8Array()),
		read({ 0: 12 }),
		length("/example"),
		length({ length: 9 }),
		borrowAndWrite("é"),
	]),
);
