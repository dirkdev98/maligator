// node:crypto acceptance fixture (behind surface.node). Exercises `hash` against
// known SHA-256 vectors over string,
// UTF-8, and byte-source (TypedArray / DataView / ArrayBuffer) inputs, plus the
// compiler-shaped `hash("sha256", JSON.stringify(x), "hex")` call, lowercase-hex
// output shape, and explicit TypeErrors for every unsupported argument form.
// Runs on the host entry; prints one line per check and a final "RESULT
// <passed>/<total>" line the native runner asserts.

import * as crypto from "node:crypto";
import { createHash, createHmac, hash, randomUUID, timingSafeEqual } from "node:crypto";

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

// --- pinned streaming SHA-1 / HMAC-SHA-256 slice ---
const streamingHash = createHash("sha1");
check("createHash update returns receiver", streamingHash.update("a") === streamingHash);
streamingHash.update(Buffer.from("b"));
streamingHash.update(new Uint8Array([0x63]));
streamingHash.update(new DataView(new Uint8Array([0x64]).buffer));
check(
	"createHash sha1 string/Buffer/TypedArray/DataView",
	streamingHash.digest("base64") === "gf6L/odXbD7LIkJvjleEc4KRes8=",
);
check(
	"createHash empty sha1",
	createHash("sha1").digest("base64") === "2jmj7l5rSw0yVb/vlWAYkK/YBwk=",
);
check(
	"createHash sha1 crosses block boundary",
	createHash("sha1").update("a".repeat(80)).digest("base64") ===
		"hvM2Uvz/1/oUQ+JG3TT+XQDiX/0=",
);
const sha1Boundaries: Array<[number, string]> = [
	[55, "wci73CJ5bijA4VFj0giZtlYh1lo="],
	[56, "wtszD2CDhUyZ1LW/tujynyAb5pk="],
	[63, "A/CfWxWKeoza2SC93Cm4HBilUfU="],
	[64, "AJi6gktcFkJ716ESKlpEKiXsZE0="],
	[65, "EWVTJscI1wMZviYQ6KV9mluVnTs="],
];
for (const [length, expected] of sha1Boundaries) {
	check(
		"createHash sha1 padding boundary " + length,
		createHash("sha1").update("a".repeat(length)).digest("base64") === expected,
	);
}
const hashWindow = Buffer.from([9, 0x61, 0x62, 0x63, 9]).subarray(1, 4);
check(
	"createHash respects Buffer window",
	createHash("sha1").update(hashWindow).digest("base64") ===
		"qZk+NkcGgWq6PiVxeFDCbJzQ2J0=",
);
check(
	"createHash accepts UTF-8 encoding aliases",
	createHash("sha1").update("abc", "UTF-8").digest("base64") ===
		"qZk+NkcGgWq6PiVxeFDCbJzQ2J0=",
);

const hmacString = createHmac("sha256", "secret-key");
check("createHmac update returns receiver", hmacString.update("session=") === hmacString);
hmacString.update(Buffer.from("maligator"));
check(
	"createHmac sha256 string key",
	hmacString.digest("base64") === "kpHI3xrUFJDNxq6ygBxXjpmB4wtYkiiBqc5+98efnZc=",
);
const hmacBytes = createHmac("sha256", new Uint8Array([1, 2, 3, 4]));
const hmacViewBuffer = new Uint8Array([9, 0x61, 0x62, 0x63, 9]).buffer;
hmacBytes.update(new DataView(hmacViewBuffer, 1, 3));
check(
	"createHmac sha256 byte key and DataView update",
	hmacBytes.digest("base64") === "1/YJqO74o32YNrAqX+EiQZhao5s+jdKGZc1Gx6feO+M=",
);
check(
	"createHmac hashes a long byte key",
	createHmac("sha256", new Uint8Array(80).fill(0xaa))
		.update("block-boundary")
		.digest("base64") === "FCy63zxM1CBFHLojYi/crst7mVCJOGnNqdENYVbPqKo=",
);
check(
	"createHmac empty key and message",
	createHmac("sha256", "").update("").digest("base64") ===
		"thNnmggU2ex3L5XXeMNfxf8Wl8STcVZTxscSFEKSxa0=",
);
check(
	"createHmac hashes a long UTF-8 string key",
	createHmac("sha256", "é".repeat(40)).update("message").digest("base64") ===
		"LPs2HVXLmBCzJQZeffm0I3Y5wYRBwCoEMaLrK+NxLsg=",
);
const hmacKeyBuffer = new Uint8Array([9, 1, 2, 3, 4, 9]).buffer;
check(
	"createHmac respects DataView key window",
	createHmac("sha256", new DataView(hmacKeyBuffer, 1, 4))
		.update("abc")
		.digest("base64") === "1/YJqO74o32YNrAqX+EiQZhao5s+jdKGZc1Gx6feO+M=",
);
const hmacKeyBoundaries: Array<[number, string]> = [
	[63, "9Y2FnWW0imxQnEYISyHFTX2EevPAcvo2t0sigubQWkg="],
	[64, "detf/jofYC6rfgkATngGR2mqDu0mHko4iN/mLWqUW04="],
	[65, "hmfJN2qAtJRqkaZx9TnrN2mgko88y/XIGaC1r2H4bRA="],
];
for (const [length, expected] of hmacKeyBoundaries) {
	check(
		"createHmac key boundary " + length,
		createHmac("sha256", new Uint8Array(length).fill(0xaa))
			.update("boundary")
			.digest("base64") === expected,
	);
}

const equalLeft = new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4);
const equalRight = new DataView(new Uint8Array([8, 1, 2, 3, 8]).buffer, 1, 3);
check("timingSafeEqual equal ArrayBufferViews", timingSafeEqual(equalLeft, equalRight));
check(
	"timingSafeEqual differing ArrayBufferViews",
	!timingSafeEqual(equalLeft, new Uint8Array([1, 2, 4])),
);
check(
	"timingSafeEqual accepts empty views",
	timingSafeEqual(new Uint8Array(), new DataView(new ArrayBuffer(0))),
);

// --- export identity and descriptors ---
check(
	"namespace exports preserve named identities",
	crypto.createHash === createHash &&
		crypto.createHmac === createHmac &&
		crypto.hash === hash &&
		crypto.randomUUID === randomUUID &&
		crypto.timingSafeEqual === timingSafeEqual,
);
check(
	"factory metadata",
	createHash.name === "createHash" &&
		createHash.length === 2 &&
		createHmac.name === "createHmac" &&
		createHmac.length === 3 &&
		hash.name === "hash" &&
		hash.length === 3 &&
		randomUUID.name === "randomUUID" &&
		randomUUID.length === 1 &&
		timingSafeEqual.name === "timingSafeEqual" &&
		timingSafeEqual.length === 0,
);
const methodPrototype = Object.getPrototypeOf(createHash("sha1"));
const updateDescriptor = Object.getOwnPropertyDescriptor(methodPrototype, "update");
const digestDescriptor = Object.getOwnPropertyDescriptor(methodPrototype, "digest");
check(
	"stream method descriptors",
	updateDescriptor?.value.name === "update" &&
		updateDescriptor.value.length === 2 &&
		updateDescriptor.writable &&
		updateDescriptor.enumerable &&
		updateDescriptor.configurable &&
		digestDescriptor?.value.name === "digest" &&
		digestDescriptor.value.length === 1 &&
		digestDescriptor.writable &&
		digestDescriptor.enumerable &&
		digestDescriptor.configurable,
);

// --- RFC 4122 version 4 UUIDs ---
const uuid = randomUUID();
check(
	"randomUUID lowercase canonical format",
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid) &&
		uuid === uuid.toLowerCase(),
);
check("randomUUID version 4", uuid[14] === "4");
check("randomUUID RFC 4122 variant", "89ab".includes(uuid[19] ?? ""));
check("randomUUID metadata", randomUUID.name === "randomUUID" && randomUUID.length === 1);
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
function throwsRangeError(name: string, fn: () => void): void {
	let error: unknown;
	try {
		fn();
	} catch (caught) {
		error = caught;
	}
	check(name, error instanceof RangeError);
}
function throwsError(name: string, fn: () => void): void {
	let error: unknown;
	try {
		fn();
	} catch (caught) {
		error = caught;
	}
	check(name, error instanceof Error);
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
throwsTypeError("createHash rejects unsupported algorithm", () => createHash("sha256"));
throwsTypeError("createHmac rejects unsupported algorithm", () =>
	createHmac("sha1", "key"),
);
throwsTypeError("createHmac requires a key", () =>
	(createHmac as (...args: unknown[]) => unknown)("sha256"),
);
throwsTypeError("createHmac rejects non-byte key", () =>
	(createHmac as (...args: unknown[]) => unknown)("sha256", new ArrayBuffer(1)),
);
throwsTypeError("stream update rejects ArrayBuffer", () =>
	createHash("sha1").update(new ArrayBuffer(1) as never),
);
throwsTypeError("stream update rejects unsupported encoding", () =>
	createHash("sha1").update("61", "hex"),
);
throwsTypeError("digest requires base64", () => createHash("sha1").digest("hex"));
const finalized = createHash("sha1");
finalized.digest("base64");
throwsError("finalized hash rejects update", () => finalized.update("again"));
throwsError("finalized hash rejects digest", () => finalized.digest("base64"));
const extractedUpdate = createHash("sha1").update;
throwsTypeError("stream methods enforce private brand", () =>
	extractedUpdate.call({}, "x"),
);
const extractedDigest = createHmac("sha256", "key").digest;
throwsTypeError("digest enforces private brand", () =>
	extractedDigest.call({}, "base64"),
);
const finalizedHmac = createHmac("sha256", "key");
finalizedHmac.digest("base64");
throwsError("finalized HMAC rejects update", () => finalizedHmac.update("again"));
throwsError("finalized HMAC rejects digest", () => finalizedHmac.digest("base64"));
throwsTypeError("timingSafeEqual requires views", () =>
	(timingSafeEqual as (...args: unknown[]) => boolean)(
		new ArrayBuffer(1),
		new Uint8Array(1),
	),
);
throwsRangeError("timingSafeEqual rejects unequal lengths", () =>
	timingSafeEqual(new Uint8Array(1), new Uint8Array(2)),
);

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
throwsTypeError("stream update rejects detached view", () =>
	createHash("sha1").update(detachedTypedArray),
);
throwsTypeError("createHmac rejects detached key view", () =>
	createHmac("sha256", detachedDataView),
);
throwsTypeError("timingSafeEqual rejects detached view", () =>
	timingSafeEqual(detachedTypedArray, new Uint8Array(0)),
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
