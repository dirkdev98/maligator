// node:crypto acceptance fixture (behind surface.node). Exercises `hash` against
// known SHA-256 vectors over string,
// UTF-8, and byte-source (TypedArray / DataView / ArrayBuffer) inputs, plus the
// compiler-shaped `hash("sha256", JSON.stringify(x), "hex")` call, lowercase-hex
// output shape, and explicit TypeErrors for every unsupported argument form.
// Runs on the host entry; prints one line per check and a final "RESULT
// <passed>/<total>" line the native runner asserts.

import { hash, randomUUID } from "node:crypto";

const results: Array<[string, boolean]> = [];
function check(name: string, ok: boolean): void {
	results.push([name, !!ok]);
}
function eq(
	name: string,
	input: string | ArrayBufferView | ArrayBuffer,
	expected: string,
): void {
	check(name, hash("sha256", input, "hex") === expected);
}

// --- known string vectors (hashed as their UTF-8 encoding) ---
eq(
	"empty string",
	"",
	"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
);
eq("abc", "abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
eq(
	"fox",
	"The quick brown fox jumps over the lazy dog",
	"d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592",
);
eq(
	"utf8 euro (3-byte)",
	"€",
	"c4cc90ed3d26f12d4b08a75140970a7904035c31cbb4515a83f19b9003c00d1d",
);
eq(
	"utf8 emoji (surrogate pair)",
	"a😀b",
	"6fba5b2ea783ded096fc2444d540ffbdf49168df30993b155b7efb683313f110",
);

// --- byte-source vectors (hashed as raw bytes, not their string form) ---
eq(
	"Uint8Array [1,2,3]",
	new Uint8Array([1, 2, 3]),
	"039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
);
eq(
	"Uint8Array 'abc' == string 'abc'",
	new Uint8Array([0x61, 0x62, 0x63]),
	"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
);
// A subarray hashes only its own window (respects byteOffset), not the whole buffer.
const framed = new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4);
eq(
	"Uint8Array subarray (byteOffset)",
	framed,
	"039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
);
eq(
	"ArrayBuffer [1,2,3]",
	new Uint8Array([1, 2, 3]).buffer,
	"039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
);
const dataViewBuffer = new Uint8Array([9, 1, 2, 3, 9]).buffer;
eq(
	"DataView window (byteOffset)",
	new DataView(dataViewBuffer, 1, 3),
	"039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
);

// --- the compiler-shaped call: hash of a JSON string (build-config.ts shortHash) ---
eq(
	"JSON.stringify object",
	JSON.stringify({ a: 1, b: [2, 3], c: "x" }),
	"05821054c91d7de7ada20697a6d3aa60700a98f7bb811ce84bd3d3f13b10a310",
);

// --- output shape: lowercase hex, exactly 64 chars ---
const digest = hash("sha256", "abc", "hex");
check("output is 64 lowercase hex chars", /^[0-9a-f]{64}$/.test(digest));
check("output has no uppercase", digest === digest.toLowerCase());
check("omitted output encoding defaults to hex", hash("sha256", "abc") === digest);

// --- RFC 4122 version 4 UUIDs ---
const uuid = randomUUID();
check(
	"randomUUID lowercase canonical format",
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid) &&
		uuid === uuid.toLowerCase(),
);
check("randomUUID version 4", uuid[14] === "4");
check("randomUUID RFC 4122 variant", "89ab".includes(uuid[19] ?? ""));
check("randomUUID metadata", randomUUID.name === "randomUUID" && randomUUID.length === 0);
const uuids: Array<string> = [];
let allUnique = true;
for (let i = 0; i < 64; i++) {
	const next = randomUUID();
	if (uuids.indexOf(next) !== -1) allUnique = false;
	uuids.push(next);
}
check("randomUUID unique sample", allUnique);

// --- rejections: unsupported forms fail without ToString coercion ---
const hashUnchecked = hash as (...args: unknown[]) => string;
function throwsTypeError(name: string, fn: () => void): void {
	let error: unknown;
	try {
		fn();
	} catch (caught) {
		error = caught;
	}
	check(name, error instanceof TypeError);
}
throwsTypeError("rejects missing algorithm", () => hashUnchecked());
throwsTypeError("rejects non-string algorithm", () => hashUnchecked(256, "abc", "hex"));
throwsTypeError("rejects non-sha256 algorithm", () => hash("md5", "abc", "hex"));
throwsTypeError("rejects non-exact sha256 algorithm", () => hash("SHA256", "abc", "hex"));
throwsTypeError("rejects missing data", () => hashUnchecked("sha256"));
throwsTypeError("rejects numeric data", () => hashUnchecked("sha256", 123, "hex"));

let toStringCalls = 0;
const coercibleObject = {
	toString(): string {
		toStringCalls++;
		return "abc";
	},
};
throwsTypeError("rejects object algorithm", () =>
	hashUnchecked(coercibleObject, "abc", "hex"),
);
throwsTypeError("rejects object data", () =>
	hashUnchecked("sha256", coercibleObject, "hex"),
);

throwsTypeError("rejects non-string output encoding", () =>
	hashUnchecked("sha256", "abc", coercibleObject),
);
check("does not coerce object arguments", toStringCalls === 0);
throwsTypeError("rejects non-hex output encoding", () => hash("sha256", "abc", "base64"));

// Detachment invalidates the buffer and every view over it. None may be treated
// as an empty input or used to form a pointer from the null backing store.
const detachable = new ArrayBuffer(3);
new Uint8Array(detachable).set([1, 2, 3]);
const detachedTypedArray = new Uint8Array(detachable);
const detachedDataView = new DataView(detachable);
detachable.transfer();
throwsTypeError("rejects detached ArrayBuffer", () => hash("sha256", detachable, "hex"));
throwsTypeError("rejects typed array over detached buffer", () =>
	hash("sha256", detachedTypedArray, "hex"),
);
throwsTypeError("rejects DataView over detached buffer", () =>
	hash("sha256", detachedDataView, "hex"),
);

// A shrink can invalidate fixed-length views while length-tracking views remain
// valid and expose their new, shorter windows.
const resizable = new ArrayBuffer(4, { maxByteLength: 8 });
new Uint8Array(resizable).set([1, 2, 3, 4]);
const fixedTypedArray = new Uint8Array(resizable, 1, 3);
const fixedDataView = new DataView(resizable, 1, 3);
const trackingTypedArray = new Uint8Array(resizable, 1);
const trackingDataView = new DataView(resizable, 1);
resizable.resize(2);
throwsTypeError("rejects typed array made OOB by resize", () =>
	hash("sha256", fixedTypedArray, "hex"),
);
throwsTypeError("rejects DataView made OOB by resize", () =>
	hash("sha256", fixedDataView, "hex"),
);
eq(
	"hashes resized length-tracking typed array",
	trackingTypedArray,
	"dbc1b4c900ffe48d575b5da5c638040125f65db0fe3e24494b76ea986457d986",
);
eq(
	"hashes resized length-tracking DataView",
	trackingDataView,
	"dbc1b4c900ffe48d575b5da5c638040125f65db0fe3e24494b76ea986457d986",
);

let passed = 0;
for (const [name, ok] of results) {
	if (ok) {
		passed++;
	} else {
		console.log("FAIL: " + name);
	}
}
console.log("RESULT " + passed + "/" + results.length);
