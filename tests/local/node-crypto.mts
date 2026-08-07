// node:crypto acceptance fixture (behind surface.node). Covers the synchronous
// surface: `hash` against known SHA-256 vectors over string, UTF-8, and
// byte-source (TypedArray / DataView / ArrayBuffer) inputs; streaming
// hash/HMAC with the full Buffer encoding set; PBKDF2; timingSafeEqual across
// every accepted source form; the CSPRNG helpers; and Argon2d/i/id known-answer
// vectors, per-parameter divergence, and the whole invalid-input table.
// Asynchronous behaviour lives in node-crypto-async.mjs; message-for-message
// agreement with Node lives in node-crypto-differential.mts.
// Runs on the host entry; prints one line per check and a final "RESULT
// <passed>/<total>" line the native runner asserts.

import * as crypto from "node:crypto";
import {
	argon2,
	argon2Sync,
	createHash,
	createHmac,
	hash,
	pbkdf2Sync,
	randomBytes,
	randomInt,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";

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

// --- PostgreSQL MD5 and SCRAM-SHA-256 primitives ---
const postgresInner = createHash("md5").update("postgrespostgres").digest("hex");
check(
	"PostgreSQL MD5 inner digest",
	postgresInner === "3175bce1d3201d16594cebf9d7eb3f9d",
);
check(
	"PostgreSQL MD5 salted digest",
	"md5" +
		createHash("md5")
			.update(
				Buffer.concat([
					Buffer.from(postgresInner),
					Buffer.from([0x12, 0x34, 0x56, 0x78]),
				]),
			)
			.digest("hex") ===
		"md5b400a301a6904ae12fc76a8fff168215",
);
const rawSha256 = createHash("sha256").update("abc").digest();
check(
	"createHash sha256 raw Buffer digest",
	Buffer.isBuffer(rawSha256) &&
		rawSha256.toString("hex") ===
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
);
const rawHmac = createHmac("sha256", "key").update("abc").digest();
check(
	"createHmac raw Buffer digest",
	Buffer.isBuffer(rawHmac) &&
		rawHmac.toString("hex") ===
			"9c196e32dc0175f86f4b1cb89289d6619de6bee699e4c378e68309ed97a1a6ab",
);
const pbkdf2Vectors: Array<[number, string]> = [
	[1, "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b"],
	[2, "ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43"],
	[4096, "c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a"],
];
for (const [iterations, expected] of pbkdf2Vectors) {
	check(
		"pbkdf2 sha256 iterations " + iterations,
		pbkdf2Sync("password", Buffer.from("salt"), iterations, 32, "sha256").toString(
			"hex",
		) === expected,
	);
}
const scramSalted = pbkdf2Sync(
	"pencil",
	Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64"),
	4096,
	32,
	"sha256",
);
const scramClientKey = createHmac("sha256", scramSalted).update("Client Key").digest();
const scramStoredKey = createHash("sha256").update(scramClientKey).digest();
const scramMessage =
	"n=*,r=fixed-client-nonce," +
	"r=fixed-client-nonce-server,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096," +
	"c=biws,r=fixed-client-nonce-server";
const scramClientSignature = createHmac("sha256", scramStoredKey)
	.update(scramMessage)
	.digest();
const scramProof = Buffer.allocUnsafe(32);
for (let i = 0; i < scramProof.length; i++) {
	scramProof[i] = (scramClientKey[i] ?? 0) ^ (scramClientSignature[i] ?? 0);
}
check(
	"SCRAM client proof",
	scramProof.toString("base64") === "J62lwuh1du5kcE8GnTagHEHw/62D0TieCdTIpDmjdmE=",
);
check(
	"SCRAM server signature",
	createHmac("sha256", createHmac("sha256", scramSalted).update("Server Key").digest())
		.update(scramMessage)
		.digest("base64") === "kry4hXu5SWE45huDYOSFspjkxKYla8Ka42woUjQ2XiU=",
);
const entropyA = randomBytes(18);
const entropyB = randomBytes(18);
check(
	"randomBytes returns requested Buffer",
	Buffer.isBuffer(entropyA) && entropyA.length === 18,
);
check("randomBytes samples differ", !timingSafeEqual(entropyA, entropyB));
check(
	"randomBytes zero length",
	Buffer.isBuffer(randomBytes(0)) && randomBytes(0).length === 0,
);

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
		crypto.pbkdf2Sync === pbkdf2Sync &&
		crypto.randomBytes === randomBytes &&
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
		pbkdf2Sync.name === "pbkdf2Sync" &&
		pbkdf2Sync.length === 5 &&
		randomBytes.name === "randomBytes" &&
		randomBytes.length === 2 &&
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
throwsTypeError("hash rejects an unknown output encoding", () =>
	hash("sha256", "abc", "bogus"),
);
throwsTypeError("createHash rejects unsupported algorithm", () => createHash("sha512"));
throwsTypeError("createHmac rejects unsupported algorithm", () =>
	createHmac("sha1", "key"),
);
throwsTypeError("createHmac requires a key", () =>
	(createHmac as (...args: unknown[]) => unknown)("sha256"),
);
throwsRangeError("randomBytes rejects negative size", () => randomBytes(-1));
throwsRangeError("pbkdf2 rejects zero iterations", () =>
	pbkdf2Sync("password", "salt", 0, 32, "sha256"),
);
throwsTypeError("pbkdf2 rejects unsupported digest", () =>
	pbkdf2Sync("password", "salt", 1, 32, "sha1"),
);
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
throwsTypeError("timingSafeEqual rejects a string", () =>
	(timingSafeEqual as (...args: unknown[]) => boolean)("a", "b"),
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

// --- encoding parity: digest, one-shot hash, and string updates -------------
const abcSha256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const abcSha256Base64 = "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=";
const abcSha256Base64Url = "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0";
check("digest hex", createHash("sha256").update("abc").digest("hex") === abcSha256);
check(
	"digest base64",
	createHash("sha256").update("abc").digest("base64") === abcSha256Base64,
);
check(
	"digest base64url omits padding",
	createHash("sha256").update("abc").digest("base64url") === abcSha256Base64Url,
);
check(
	"digest latin1 keeps one char per byte",
	createHash("sha256").update("abc").digest("latin1").length === 32,
);
// Node's ParseEncoding falls back to BUFFER, so an unrecognized digest encoding
// returns the raw bytes instead of throwing. crypto.hash() is the call site that
// does throw; both behaviours are pinned in the differential fixture.
const bogusDigest = createHash("sha256")
	.update("abc")
	.digest("bogus" as never);
check(
	"digest falls back to a Buffer for an unknown encoding",
	Buffer.isBuffer(bogusDigest) && bogusDigest.toString("hex") === abcSha256,
);
const numericDigest = createHash("sha256")
	.update("abc")
	.digest(5 as never) as unknown as Buffer;
check(
	"digest falls back to a Buffer for a non-string encoding",
	Buffer.isBuffer(numericDigest) && numericDigest.toString("hex") === abcSha256,
);
check("hash base64url", hash("sha256", "abc", "base64url") === abcSha256Base64Url);
check("hash base64", hash("sha256", "abc", "base64") === abcSha256Base64);
check(
	'hash "buffer" encoding returns bytes',
	Buffer.isBuffer(hash("sha256", "abc", "buffer") as never) &&
		(hash("sha256", "abc", "buffer") as never as Buffer).toString("hex") === abcSha256,
);
check(
	"update decodes hex like Buffer.from",
	createHash("sha256").update("616263", "hex").digest("hex") === abcSha256,
);
check(
	"update decodes base64",
	createHash("sha256").update("YWJj", "base64").digest("hex") === abcSha256,
);
check(
	"update decodes base64url",
	createHash("sha256").update("YWJj", "base64url").digest("hex") === abcSha256,
);
check(
	"update decodes latin1",
	createHash("sha256").update("abc", "latin1").digest("hex") === abcSha256,
);
check(
	"update falls back to utf8 for an unknown encoding",
	createHash("sha256")
		.update("abc", "bogus" as never)
		.digest("hex") === abcSha256,
);
check(
	"update accepts an ArrayBuffer",
	createHash("sha256")
		.update(new Uint8Array([0x61, 0x62, 0x63]).buffer as never)
		.digest("hex") === abcSha256,
);
check(
	"createHmac accepts an ArrayBuffer key",
	createHmac("sha256", new Uint8Array([1, 2, 3, 4]).buffer as never)
		.update("abc")
		.digest("hex") ===
		createHmac("sha256", new Uint8Array([1, 2, 3, 4]))
			.update("abc")
			.digest("hex"),
);
// Incremental and one-shot must agree over a block boundary.
const incremental = createHash("sha256");
for (let i = 0; i < 200; i++) incremental.update("x");
check(
	"incremental equals one-shot",
	incremental.digest("hex") === hash("sha256", "x".repeat(200), "hex"),
);
const incrementalHmac = createHmac("sha256", "k");
incrementalHmac.update("ab");
incrementalHmac.update("c");
check(
	"incremental HMAC equals one-shot",
	incrementalHmac.digest("hex") === createHmac("sha256", "k").update("abc").digest("hex"),
);

// --- timingSafeEqual over every accepted source form ------------------------
const tseBytes = [1, 2, 3, 4, 5, 6, 7, 8];
const tseBuffer = new Uint8Array(tseBytes).buffer;
const tseForms: Array<[string, ArrayBufferView | ArrayBuffer]> = [
	["ArrayBuffer", tseBuffer],
	["Uint8Array", new Uint8Array(tseBytes)],
	["Int8Array", new Int8Array(new Uint8Array(tseBytes).buffer)],
	["Uint16Array", new Uint16Array(new Uint8Array(tseBytes).buffer)],
	["Float64Array", new Float64Array(new Uint8Array(tseBytes).buffer)],
	["DataView", new DataView(new Uint8Array(tseBytes).buffer)],
	["Buffer", Buffer.from(tseBytes)],
];
let tseAllEqual = true;
for (const [, form] of tseForms) {
	for (const [, other] of tseForms) {
		if (!timingSafeEqual(form as never, other as never)) tseAllEqual = false;
	}
}
check("timingSafeEqual accepts every byte-source pairing", tseAllEqual);
check(
	"timingSafeEqual respects a subarray window",
	timingSafeEqual(
		new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4),
		new Uint8Array([1, 2, 3]),
	),
);
check(
	"timingSafeEqual reports a single differing byte",
	!timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])),
);

// --- randomBytes / randomInt / randomUUID -----------------------------------
check("randomBytes truncates a fractional size", randomBytes(1.5).length === 1);
check("randomBytes truncates 3.9 to 3", randomBytes(3.9).length === 3);
throwsTypeError("randomBytes rejects a numeric string", () =>
	(randomBytes as (...args: unknown[]) => unknown)("8"),
);
throwsTypeError("randomBytes rejects null", () =>
	(randomBytes as (...args: unknown[]) => unknown)(null),
);
throwsTypeError("randomBytes rejects a missing size", () =>
	(randomBytes as (...args: unknown[]) => unknown)(),
);
throwsRangeError("randomBytes rejects NaN", () => randomBytes(NaN));
throwsRangeError("randomBytes rejects Infinity", () => randomBytes(Infinity));
throwsRangeError("randomBytes rejects 2^31", () => randomBytes(2147483648));
throwsTypeError("randomBytes rejects a non-function callback", () =>
	(randomBytes as (...args: unknown[]) => unknown)(16, 5),
);

// 200 is the range that makes the rejection loop observable: a single byte
// covers it, and 256 % 200 = 56, so a bare `draw % 200` would hand out 0..55
// twice as often as 56..199. With 40 000 samples the uniform expectation is 200
// per bucket (sd ~14); the modulo-biased low buckets would sit near 312. The
// bounds below are wide enough that a correct implementation effectively never
// trips them and narrow enough that the bug cannot hide. This is a smoke check
// on the loop, not a statistical certification — the loop's correctness is
// established by reading crypto_random_below and its driver coverage.
let randomIntInRange = true;
const randomIntCounts = new Map<number, number>();
for (let i = 0; i < 40000; i++) {
	const value = randomInt(0, 200);
	if (!Number.isInteger(value) || value < 0 || value >= 200) randomIntInRange = false;
	randomIntCounts.set(value, (randomIntCounts.get(value) ?? 0) + 1);
}
check("randomInt stays in [min, max)", randomIntInRange);
let randomIntSpread = randomIntCounts.size === 200;
for (const count of randomIntCounts.values()) {
	if (count < 120 || count > 290) randomIntSpread = false;
}
check("randomInt shows no modulo bias over a range of 200", randomIntSpread);
// The same range through the wider draw path: a range needing two bytes must
// reject just as carefully.
let wideInRange = true;
for (let i = 0; i < 2000; i++) {
	const value = randomInt(0, 70000);
	if (!Number.isInteger(value) || value < 0 || value >= 70000) wideInRange = false;
}
check("randomInt stays in range across a multi-byte draw", wideInRange);
check(
	"randomInt defaults min to 0",
	(() => {
		let ok = true;
		for (let i = 0; i < 200; i++) {
			const value = randomInt(3);
			if (value < 0 || value >= 3) ok = false;
		}
		return ok;
	})(),
);
check(
	"randomInt accepts a negative min",
	(() => {
		let ok = true;
		for (let i = 0; i < 200; i++) {
			const value = randomInt(-5, -1);
			if (value < -5 || value >= -1) ok = false;
		}
		return ok;
	})(),
);
check(
	"randomInt spans the maximum permitted range",
	Number.isInteger(randomInt(0, 281474976710655)),
);
throwsTypeError("randomInt rejects a fractional max", () => randomInt(1.5));
throwsTypeError("randomInt rejects a numeric string", () =>
	(randomInt as (...args: unknown[]) => unknown)("5"),
);
throwsTypeError("randomInt rejects an unsafe integer", () =>
	randomInt(Number.MAX_SAFE_INTEGER + 1),
);
throwsRangeError("randomInt rejects max <= min", () => randomInt(5, 4));
throwsRangeError("randomInt rejects an equal min and max", () => randomInt(1, 1));
throwsRangeError("randomInt rejects a range above 2^48-1", () =>
	randomInt(0, 281474976710656),
);
// Node validates the callback before the numeric bounds, so a call that is
// wrong in both ways reports the callback. Getting this backwards would also
// mean drawing entropy for a call that is about to throw.
throwsTypeError("randomInt reports a bad callback before bad bounds", () =>
	(randomInt as (...args: unknown[]) => unknown)(5, 4, 5),
);
throwsTypeError("randomInt reports a bad callback before a bad min", () =>
	(randomInt as (...args: unknown[]) => unknown)(1.5, 5, 5),
);
throwsTypeError("randomInt reports a bad callback before an over-wide range", () =>
	(randomInt as (...args: unknown[]) => unknown)(0, 281474976710656, 5),
);
throwsTypeError("randomInt still reports a bad min when the callback is valid", () =>
	(randomInt as (...args: unknown[]) => unknown)(1.5, 5, () => undefined),
);
// `max === undefined` shifts the arguments down, so the third argument is not a
// callback and is ignored outright.
check(
	"randomInt ignores a third argument when max is undefined",
	Number.isInteger((randomInt as (...args: unknown[]) => number)(5, undefined, 5)),
);
check("randomInt metadata", randomInt.name === "randomInt" && randomInt.length === 3);

throwsTypeError("randomUUID rejects null options", () =>
	(randomUUID as (...args: unknown[]) => unknown)(null),
);
throwsTypeError("randomUUID rejects non-object options", () =>
	(randomUUID as (...args: unknown[]) => unknown)(5),
);
throwsTypeError("randomUUID rejects a non-boolean disableEntropyCache", () =>
	(randomUUID as (...args: unknown[]) => unknown)({ disableEntropyCache: 1 }),
);
check(
	"randomUUID accepts an explicit options bag",
	randomUUID({ disableEntropyCache: true }).length === 36 &&
		randomUUID({ disableEntropyCache: false }).length === 36 &&
		randomUUID({}).length === 36,
);
const uncachedUuids = new Set<string>();
for (let i = 0; i < 32; i++) uncachedUuids.add(randomUUID({ disableEntropyCache: true }));
check("randomUUID stays unique with the cache disabled", uncachedUuids.size === 32);

// --- Argon2: RFC 9106 known-answer vectors ----------------------------------
type Argon2Parameters = Parameters<typeof argon2Sync>[1];
function rfc9106(overrides: Partial<Argon2Parameters> = {}): Argon2Parameters {
	return {
		message: Buffer.alloc(32, 0x01),
		nonce: Buffer.alloc(16, 0x02),
		secret: Buffer.alloc(8, 0x03),
		associatedData: Buffer.alloc(12, 0x04),
		parallelism: 4,
		tagLength: 32,
		memory: 32,
		passes: 3,
		...overrides,
	} as Argon2Parameters;
}
const KAT: Array<[string, string]> = [
	["argon2d", "512b391b6f1162975371d30919734294f868e3be3984f3c1a13a4db9fabe4acb"],
	["argon2i", "c814d9d1dc7f37aa13f0d77f2494bda1c8de6b016dd388d29952a4c4672b6ce8"],
	["argon2id", "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659"],
];
for (const [algorithm, expected] of KAT) {
	check(
		"RFC 9106 vector " + algorithm,
		argon2Sync(algorithm as never, rfc9106()).toString("hex") === expected,
	);
}
const baseline = argon2Sync("argon2id", rfc9106()).toString("hex");
// One parameter at a time: every input must reach the derivation.
const divergences: Array<[string, Partial<Argon2Parameters>]> = [
	["message", { message: Buffer.alloc(32, 0x02) }],
	["nonce", { nonce: Buffer.alloc(16, 0x03) }],
	["secret", { secret: Buffer.alloc(8, 0x04) }],
	["associatedData", { associatedData: Buffer.alloc(12, 0x05) }],
	["passes", { passes: 4 }],
	["memory", { memory: 33 }],
	["parallelism", { parallelism: 2 }],
	["tagLength", { tagLength: 33 }],
];
for (const [name, override] of divergences) {
	check(
		"argon2 " + name + " changes the tag",
		argon2Sync("argon2id", rfc9106(override)).toString("hex") !== baseline,
	);
}
check(
	"argon2 variants differ from one another",
	new Set(KAT.map(([, expected]) => expected)).size === 3,
);
// Argon2 hashes the un-rounded `memory` into H0 while rounding only the block
// count, so 8/9/11 (all eight blocks at p=1) still produce different tags.
const rounded = [8, 9, 11, 12].map((memory) =>
	argon2Sync("argon2id", {
		message: "pw",
		nonce: "0123456789abcdef",
		parallelism: 1,
		tagLength: 32,
		memory,
		passes: 1,
	} as never).toString("hex"),
);
check("argon2 does not pre-round memory", new Set(rounded).size === 4);
check(
	"argon2 honours tagLength",
	argon2Sync("argon2id", rfc9106({ tagLength: 4 })).length === 4 &&
		argon2Sync("argon2id", rfc9106({ tagLength: 64 })).length === 64,
);
check(
	"argon2 accepts every byte-source form",
	(() => {
		const parameters = {
			parallelism: 1,
			tagLength: 32,
			memory: 32,
			passes: 2,
		};
		const fromView = argon2Sync("argon2id", {
			...parameters,
			message: new Uint8Array([1, 2, 3]),
			nonce: new Uint8Array(8).fill(2),
		} as never).toString("hex");
		const fromArrayBuffer = argon2Sync("argon2id", {
			...parameters,
			message: new Uint8Array([1, 2, 3]).buffer,
			nonce: new Uint8Array(8).fill(2).buffer,
		} as never).toString("hex");
		const fromDataView = argon2Sync("argon2id", {
			...parameters,
			message: new DataView(new Uint8Array([1, 2, 3]).buffer),
			nonce: new DataView(new Uint8Array(8).fill(2).buffer),
		} as never).toString("hex");
		return fromView === fromArrayBuffer && fromView === fromDataView;
	})(),
);
check(
	"argon2 measures string inputs as UTF-8",
	argon2Sync("argon2id", {
		message: "password",
		nonce: "01234567",
		parallelism: 1,
		tagLength: 32,
		memory: 32,
		passes: 2,
	} as never).toString("hex") ===
		argon2Sync("argon2id", {
			message: Buffer.from("password", "utf8"),
			nonce: Buffer.from("01234567", "utf8"),
			parallelism: 1,
			tagLength: 32,
			memory: 32,
			passes: 2,
		} as never).toString("hex"),
);
check(
	"argon2 ignores unknown parameter keys",
	argon2Sync("argon2id", rfc9106({ bogus: 1 } as never)).toString("hex") === baseline,
);
check(
	"argon2 treats an absent optional input as empty",
	argon2Sync("argon2id", {
		message: "pw",
		nonce: "0123456789abcdef",
		secret: undefined,
		associatedData: undefined,
		parallelism: 1,
		tagLength: 32,
		memory: 32,
		passes: 1,
	} as never).toString("hex") ===
		argon2Sync("argon2id", {
			message: "pw",
			nonce: "0123456789abcdef",
			parallelism: 1,
			tagLength: 32,
			memory: 32,
			passes: 1,
		} as never).toString("hex"),
);
// Associated data past 32 bytes is the exact bound RustCrypto's argon2 caps at,
// so this is the guard against a backend swap silently breaking Node parity.
check(
	"argon2 accepts associated data past 32 bytes",
	new Set(
		[32, 33, 1000].map((size) =>
			argon2Sync("argon2id", rfc9106({ associatedData: Buffer.alloc(size, 4) })).toString(
				"hex",
			),
		),
	).size === 3,
);

// --- Argon2 property read order ---------------------------------------------
// Node reads all eight in this order before validating any of them, so a getter
// cannot observe a partially validated bag. (Node re-reads secret and
// associatedData a second time on the synchronous path; Maligator reads each
// once, which the differential fixture compares as first-occurrence order.)
const readOrder: Array<string> = [];
const probed = new Proxy(rfc9106() as unknown as Record<string, unknown>, {
	get(target, key): unknown {
		if (typeof key === "string" && !readOrder.includes(key)) readOrder.push(key);
		return target[key];
	},
});
argon2Sync("argon2id", probed as never);
check(
	"argon2 reads parameters in Node's order",
	readOrder.join(",") ===
		"parallelism,tagLength,memory,passes,message,nonce,secret,associatedData",
);

// --- Argon2 invalid inputs ---------------------------------------------------
throwsTypeError("argon2Sync rejects a non-string algorithm", () =>
	(argon2Sync as (...args: unknown[]) => unknown)(5, rfc9106()),
);
throwsTypeError("argon2Sync rejects an unknown algorithm", () =>
	(argon2Sync as (...args: unknown[]) => unknown)("argon2x", rfc9106()),
);
throwsTypeError("argon2Sync rejects non-object parameters", () =>
	(argon2Sync as (...args: unknown[]) => unknown)("argon2id", 5),
);
throwsTypeError("argon2Sync rejects missing parameters", () =>
	(argon2Sync as (...args: unknown[]) => unknown)("argon2id"),
);
throwsTypeError("argon2Sync rejects a numeric message", () =>
	argon2Sync("argon2id", rfc9106({ message: 5 as never })),
);
throwsTypeError("argon2Sync rejects a numeric nonce", () =>
	argon2Sync("argon2id", rfc9106({ nonce: 5 as never })),
);
throwsRangeError("argon2Sync rejects a short nonce", () =>
	argon2Sync("argon2id", rfc9106({ nonce: Buffer.alloc(7) })),
);
throwsTypeError("argon2Sync rejects a string parallelism", () =>
	argon2Sync("argon2id", rfc9106({ parallelism: "4" as never })),
);
throwsRangeError("argon2Sync rejects a fractional parallelism", () =>
	argon2Sync("argon2id", rfc9106({ parallelism: 1.5 })),
);
throwsRangeError("argon2Sync rejects parallelism 0", () =>
	argon2Sync("argon2id", rfc9106({ parallelism: 0 })),
);
throwsRangeError("argon2Sync rejects parallelism above 2^24-1", () =>
	argon2Sync("argon2id", rfc9106({ parallelism: 16777216 })),
);
throwsRangeError("argon2Sync rejects tagLength below 4", () =>
	argon2Sync("argon2id", rfc9106({ tagLength: 3 })),
);
throwsRangeError("argon2Sync rejects a fractional tagLength", () =>
	argon2Sync("argon2id", rfc9106({ tagLength: 1.5 })),
);
throwsRangeError("argon2Sync rejects memory below 8 * parallelism", () =>
	argon2Sync("argon2id", rfc9106({ parallelism: 2, memory: 8 })),
);
throwsRangeError("argon2Sync rejects memory above 2^32-1", () =>
	argon2Sync("argon2id", rfc9106({ memory: 4294967296 })),
);
throwsRangeError("argon2Sync rejects passes 0", () =>
	argon2Sync("argon2id", rfc9106({ passes: 0 })),
);
throwsRangeError("argon2Sync rejects a fractional passes", () =>
	argon2Sync("argon2id", rfc9106({ passes: 1.5 })),
);
// Deliberate divergence: Node 24.14.1 raises ERR_INTERNAL_ASSERTION ("'name'
// must be a string ... open an issue") for these; a proper TypeError is the
// correct behaviour and is excluded from the differential fixture.
throwsTypeError("argon2Sync rejects a null secret with a TypeError", () =>
	argon2Sync("argon2id", rfc9106({ secret: null as never })),
);
throwsTypeError("argon2Sync rejects a numeric secret with a TypeError", () =>
	argon2Sync("argon2id", rfc9106({ secret: 5 as never })),
);
throwsTypeError("argon2Sync rejects a null associatedData with a TypeError", () =>
	argon2Sync("argon2id", rfc9106({ associatedData: null as never })),
);
// --- host resource policy ----------------------------------------------------
// Deliberate divergence, and the only one that is a policy rather than a bug
// workaround: Node's documented ranges reach 4 TiB of `memory` and 4 GiB of
// `tagLength`, and a request anywhere near either gets Node's process SIGKILLed.
// Maligator keeps Node's *validation* range verbatim — everything below is a
// plain Error, never a RangeError — and then refuses what its own resource
// policy will not fund. Defaults: 256 MiB of matrix, 16 MiB of tag.
// Never differential: Node cannot survive these inputs to disagree with.
const HOST_MAX_MEMORY_KIB = 262144;
const HOST_MAX_TAG_LENGTH = 16777216;
// The ceiling is compared against the *rounded* block count, which is what the
// derivation actually allocates, so exceeding it means clearing the next
// 4*parallelism-block step (16 blocks at the parallelism of 4 used here) rather
// than merely adding one KiB.
const OVER_MEMORY_POLICY = HOST_MAX_MEMORY_KIB + 16;
throwsError("argon2Sync refuses memory above the host ceiling", () =>
	argon2Sync("argon2id", rfc9106({ memory: OVER_MEMORY_POLICY })),
);
throwsError("argon2Sync refuses the maximum memory Node documents", () =>
	argon2Sync("argon2id", rfc9106({ memory: 4294967295 })),
);
throwsError("argon2Sync refuses a tagLength above the host ceiling", () =>
	argon2Sync("argon2id", rfc9106({ tagLength: HOST_MAX_TAG_LENGTH + 1 })),
);
throwsError("argon2Sync refuses the maximum tagLength Node documents", () =>
	argon2Sync("argon2id", rfc9106({ tagLength: 4294967295 })),
);
// A resource refusal is an Error, not a RangeError: the value was inside the
// range Node documents, so reporting it as out of range would be wrong.
check(
	"a policy refusal is a plain Error, not a RangeError",
	(() => {
		try {
			argon2Sync("argon2id", rfc9106({ memory: OVER_MEMORY_POLICY }));
		} catch (error) {
			return error instanceof Error && !(error instanceof RangeError);
		}
		return false;
	})(),
);
// The boundary itself still derives: the ceiling is inclusive, and a value one
// step inside it is ordinary work. (Only the tag ceiling is cheap enough to
// exercise directly; a 256 MiB matrix is left to the C driver.)
check(
	"a tagLength just inside the ceiling still derives",
	argon2Sync("argon2id", rfc9106({ tagLength: 4096 })).length === 4096,
);
throwsError("argon2 refuses an over-policy memory request", () =>
	(argon2 as (...args: unknown[]) => unknown)(
		"argon2id",
		rfc9106({ memory: OVER_MEMORY_POLICY }),
		() => undefined,
	),
);
throwsError("argon2 refuses an over-policy tagLength", () =>
	(argon2 as (...args: unknown[]) => unknown)(
		"argon2id",
		rfc9106({ tagLength: HOST_MAX_TAG_LENGTH + 1 }),
		() => undefined,
	),
);

throwsTypeError("argon2 rejects a missing callback", () =>
	(argon2 as (...args: unknown[]) => unknown)("argon2id", rfc9106()),
);
throwsTypeError("argon2 rejects a non-function callback", () =>
	(argon2 as (...args: unknown[]) => unknown)("argon2id", rfc9106(), 5),
);
throwsTypeError("argon2 validates the algorithm before the callback", () =>
	(argon2 as (...args: unknown[]) => unknown)(5, rfc9106(), 5),
);

check(
	"argon2 export metadata",
	argon2.name === "argon2" &&
		argon2.length === 3 &&
		argon2Sync.name === "argon2Sync" &&
		argon2Sync.length === 2,
);
check(
	"namespace exposes the new named exports",
	crypto.argon2 === argon2 &&
		crypto.argon2Sync === argon2Sync &&
		crypto.randomInt === randomInt,
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
