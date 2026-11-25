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

globalThis.hostRead = read;
globalThis.hostLength = length;
console.log(
	JSON.stringify([
		read(new Uint8Array([231])),
		read(new Uint8Array()),
		read({ 0: 12 }),
		length("/example"),
		length({ length: 9 }),
	]),
);
