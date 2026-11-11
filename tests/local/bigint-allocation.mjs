import assert from "node:assert/strict";
import { transcode } from "node:buffer";
import { KeyObject, createCipheriv } from "node:crypto";
import querystring from "node:querystring";
import { inspect } from "node:util";

const { armFailure, opaque, consoleMode, complete } = globalThis;
const wide = opaque((1n << 521n) + 123456789n);
const typed = new BigInt64Array([opaque(9223372036854775807n), opaque(987654321n)]);
function fails(name, operation, mode) {
	let caught;
	armFailure(mode);
	try {
		operation();
	} catch (error) {
		caught = error;
	} finally {
		armFailure(0);
	}
	assert.equal(caught?.message, "Out of memory", name);
}
const sortable = [wide, wide + 1n];
const increment = () => called++;
const compare = () => {
	called++;
	return 0;
};
const nested = { value: wide };
const cipherOptions = { authTagLength: wide };
for (const mode of [1, 2]) {
	fails("String(BigInt)", () => String(wide), mode);
	fails("string concatenation", () => "" + wide, mode);
	fails("primitive default sort", () => sortable.sort(), mode);
	fails("inspect BigInt", () => inspect(wide), mode);
}
fails("promoting arithmetic", () => wide + wide, 1);
fails(
	"StringToBigInt equality",
	() => wide == opaque("12345678901234567890123456789012345678901234567890"),
	1,
);
fails("typed indexed read", () => typed[0], 1);
fails("typed descriptor read", () => Object.getOwnPropertyDescriptor(typed, "0"), 1);
fails("typed join", () => typed.join(), 1);
fails("typed locale string", () => typed.toLocaleString(), 1);
fails("typed inspect", () => inspect(typed), 1);
const partial = new BigInt64Array([opaque(987654321n)]);
fails("partial typed comparison", () => assert.partialDeepStrictEqual(typed, partial), 1);
let called = 0;
fails("typed callback", () => typed.forEach(increment), 1);
assert.equal(called, 0);
fails("typed custom sort", () => typed.sort(compare), 1);
assert.equal(called, 0);
fails(
	"typed iterator",
	() => {
		for (const value of typed) {
			called++;
			opaque(value);
		}
	},
	1,
);
assert.equal(called, 0);
consoleMode(false);
fails("plain console BigInt", () => console.log(wide), 2);
fails("plain console nested BigInt", () => console.log(nested), 2);
consoleMode(true);
let encoded = 0;
const query = {
	get value() {
		armFailure(2);
		return wide;
	},
};
fails(
	"querystring before custom encoder",
	() =>
		querystring.stringify(query, "&", "=", {
			encodeURIComponent(value) {
				encoded++;
				return value;
			},
		}),
	0,
);
assert.equal(encoded, 1);
fails("native diagnostic", () => transcode(wide, "utf8", "utf8"), 2);
const key = new Uint8Array(16),
	iv = new Uint8Array(12);
fails("crypto value diagnostic", () => new KeyObject(wide), 2);
fails(
	"crypto option diagnostic",
	() => createCipheriv("aes-128-gcm", key, iv, cipherOptions),
	2,
);
assert.equal(wide.toString(16), ((1n << 521n) + 123456789n).toString(16));
assert.equal(typed[0], 9223372036854775807n);
complete();
