// Deterministic node:crypto differential fixture.
//
// Every line printed here must be byte-identical under `process.execPath` and
// under the compiled and interpreted Maligator binaries, so nothing in it may
// consume randomness or depend on timing.
//
// Deliberately excluded, because Maligator and Node genuinely disagree and the
// Maligator behaviour is the intended one:
//   * an Argon2 `memory` beyond the host ceiling (a JavaScript Error here, a
//     SIGKILLed process in Node);
//   * a wrongly typed `parameters.secret` / `parameters.associatedData` (a
//     TypeError here, ERR_INTERNAL_ASSERTION in Node 24.14.1);
//   * `crypto.hash` over an ArrayBuffer, which Maligator accepts and Node
//     rejects (pre-existing, out of this issue's scope).
// Those cases are pinned in node-crypto.mts instead.

import {
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

const lines: Array<string> = [];
function record(label: string, produce: () => unknown): void {
	try {
		const value = produce();
		lines.push(label + " => " + String(value));
	} catch (error) {
		const thrown = error as Error;
		lines.push(label + " !! " + thrown.constructor.name + ": " + thrown.message);
	}
}

// --- digests and HMAC --------------------------------------------------------
const vectors: Array<[string, string]> = [
	["", ""],
	["abc", "abc"],
	["fox", "The quick brown fox jumps over the lazy dog"],
	["euro", "€"],
	["emoji", "a\u{1f600}b"],
];
for (const [name, input] of vectors) {
	record("sha256 hex " + name, () => hash("sha256", input, "hex"));
	record("sha256 base64 " + name, () => hash("sha256", input, "base64"));
	record("sha256 base64url " + name, () => hash("sha256", input, "base64url"));
	record("sha256 default " + name, () => hash("sha256", input));
	record("createHash sha256 " + name, () =>
		createHash("sha256").update(input).digest("hex"),
	);
	record("createHash sha1 " + name, () => createHash("sha1").update(input).digest("hex"));
	record("createHash md5 " + name, () => createHash("md5").update(input).digest("hex"));
	record("hmac sha256 " + name, () =>
		createHmac("sha256", "secret-key").update(input).digest("hex"),
	);
}
record("digest buffer", () =>
	createHash("sha256").update("abc").digest().toString("hex"),
);
record(
	"digest latin1 length",
	() => createHash("sha256").update("abc").digest("latin1").length,
);
// Node's ParseEncoding falls back to BUFFER for an unrecognized digest encoding.
record("digest unknown encoding falls back to a Buffer", () =>
	(
		createHash("sha256")
			.update("abc")
			.digest("bogus" as never) as unknown as Buffer
	).toString("hex"),
);
record("update hex", () => createHash("sha256").update("616263", "hex").digest("hex"));
record("update base64", () =>
	createHash("sha256").update("YWJj", "base64").digest("hex"),
);
record("update base64url", () =>
	createHash("sha256").update("YWJj", "base64url").digest("hex"),
);
record("update latin1", () => createHash("sha256").update("abc", "latin1").digest("hex"));
record("update unknown encoding falls back to utf8", () =>
	createHash("sha256")
		.update("abc", "bogus" as never)
		.digest("hex"),
);
record("hmac ArrayBuffer key", () =>
	createHmac("sha256", new Uint8Array([1, 2, 3, 4]).buffer as never)
		.update("abc")
		.digest("hex"),
);
record("hmac long key", () =>
	createHmac("sha256", new Uint8Array(80).fill(0xaa)).update("x").digest("hex"),
);
record("pbkdf2 sha256", () =>
	pbkdf2Sync("password", Buffer.from("salt"), 4096, 32, "sha256").toString("hex"),
);
record("hash buffer encoding", () =>
	(hash("sha256", "abc", "buffer") as unknown as Buffer).toString("hex"),
);

// --- timingSafeEqual ---------------------------------------------------------
record("tse ArrayBuffer pair", () =>
	timingSafeEqual(
		new Uint8Array([1, 2, 3]).buffer as never,
		new Uint8Array([1, 2, 3]).buffer as never,
	),
);
record("tse ArrayBuffer vs view", () =>
	timingSafeEqual(new Uint8Array([1, 2, 3]).buffer as never, new Uint8Array([1, 2, 3])),
);
record("tse DataView vs Buffer", () =>
	timingSafeEqual(new DataView(new Uint8Array([1, 2]).buffer), Buffer.from([1, 2])),
);
record("tse unequal contents", () =>
	timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])),
);
record("tse empty", () => timingSafeEqual(new Uint8Array(), new Uint8Array()));
record("tse unequal lengths", () =>
	timingSafeEqual(new Uint8Array(1), new Uint8Array(2)),
);
record("tse rejects a string", () =>
	(timingSafeEqual as (...args: unknown[]) => boolean)("a", "b"),
);

// --- Argon2 success values ---------------------------------------------------
type Argon2Parameters = Parameters<typeof argon2Sync>[1];
function rfc9106(overrides: Record<string, unknown> = {}): Argon2Parameters {
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
for (const algorithm of ["argon2d", "argon2i", "argon2id"]) {
	record("argon2 kat " + algorithm, () =>
		argon2Sync(algorithm as never, rfc9106()).toString("hex"),
	);
}
const axes: Array<[string, Record<string, unknown>]> = [
	["message", { message: Buffer.alloc(32, 0x02) }],
	["message string", { message: "password", nonce: "0123456789abcdef" }],
	["nonce", { nonce: Buffer.alloc(16, 0x03) }],
	["nonce string", { nonce: "01234567" }],
	["nonce 8 bytes", { nonce: Buffer.alloc(8, 0x02) }],
	["secret", { secret: Buffer.alloc(8, 0x04) }],
	["secret empty", { secret: Buffer.alloc(0) }],
	["secret absent", { secret: undefined }],
	["associatedData", { associatedData: Buffer.alloc(12, 0x05) }],
	["associatedData 33", { associatedData: Buffer.alloc(33, 0x04) }],
	["associatedData 1000", { associatedData: Buffer.alloc(1000, 0x04) }],
	["associatedData absent", { associatedData: undefined }],
	["passes 1", { passes: 1 }],
	["passes 4", { passes: 4 }],
	["memory 32", { memory: 32 }],
	["memory 33", { memory: 33 }],
	["memory 64", { memory: 64 }],
	["parallelism 1", { parallelism: 1, memory: 8 }],
	["parallelism 2", { parallelism: 2, memory: 16 }],
	["tagLength 4", { tagLength: 4 }],
	["tagLength 16", { tagLength: 16 }],
	["tagLength 64", { tagLength: 64 }],
	["empty message", { message: Buffer.alloc(0) }],
	["extra keys", { bogus: 1 }],
	[
		"ArrayBuffer inputs",
		{
			message: new Uint8Array([1, 2, 3]).buffer,
			nonce: new Uint8Array(8).fill(2).buffer,
		},
	],
	[
		"DataView inputs",
		{
			message: new DataView(new Uint8Array([1, 2, 3]).buffer),
			nonce: new DataView(new Uint8Array(8).fill(2).buffer),
		},
	],
];
for (const [name, override] of axes) {
	record("argon2id " + name, () =>
		argon2Sync("argon2id", rfc9106(override)).toString("hex"),
	);
}
// Argon2 hashes the caller's `memory` into H0 and rounds only the block count,
// so these four must be four different tags even though 8/9/11 all round to 8.
for (const memory of [8, 9, 11, 12]) {
	record("argon2id unrounded memory " + memory, () =>
		argon2Sync("argon2id", {
			message: "pw",
			nonce: "0123456789abcdef",
			parallelism: 1,
			tagLength: 32,
			memory,
			passes: 1,
		} as never).toString("hex"),
	);
}
// Node re-reads secret and associatedData on the synchronous path; comparing
// first occurrences pins the order both implementations agree on.
const readOrder: Array<string> = [];
argon2Sync(
	"argon2id",
	new Proxy(rfc9106() as unknown as Record<string, unknown>, {
		get(target, key): unknown {
			if (typeof key === "string" && !readOrder.includes(key)) readOrder.push(key);
			return target[key];
		},
	}) as never,
);
lines.push("argon2 read order => " + readOrder.join(","));

// --- error shapes ------------------------------------------------------------
record("argon2 non-string algorithm", () =>
	(argon2Sync as (...args: unknown[]) => unknown)(5, rfc9106()),
);
record("argon2 unknown algorithm", () =>
	(argon2Sync as (...args: unknown[]) => unknown)("argon2x", rfc9106()),
);
record("argon2 non-object parameters", () =>
	(argon2Sync as (...args: unknown[]) => unknown)("argon2id", 5),
);
record("argon2 missing parameters", () =>
	(argon2Sync as (...args: unknown[]) => unknown)("argon2id"),
);
record("argon2 numeric message", () => argon2Sync("argon2id", rfc9106({ message: 5 })));
record("argon2 numeric nonce", () => argon2Sync("argon2id", rfc9106({ nonce: 5 })));
record("argon2 short nonce", () =>
	argon2Sync("argon2id", rfc9106({ nonce: Buffer.alloc(7) })),
);
record("argon2 short string nonce", () =>
	argon2Sync("argon2id", rfc9106({ nonce: "0123456" })),
);
record("argon2 message before nonce", () =>
	argon2Sync("argon2id", rfc9106({ message: 5, nonce: 5 })),
);
record("argon2 nonce before parallelism", () =>
	argon2Sync("argon2id", rfc9106({ nonce: 5, parallelism: 0 })),
);
record("argon2 string parallelism", () =>
	argon2Sync("argon2id", rfc9106({ parallelism: "4" })),
);
record("argon2 fractional parallelism", () =>
	argon2Sync("argon2id", rfc9106({ parallelism: 1.5 })),
);
record("argon2 parallelism 0", () => argon2Sync("argon2id", rfc9106({ parallelism: 0 })));
record("argon2 parallelism 16777216", () =>
	argon2Sync("argon2id", rfc9106({ parallelism: 16777216 })),
);
record("argon2 parallelism before tagLength", () =>
	argon2Sync("argon2id", rfc9106({ parallelism: 0, tagLength: 1 })),
);
record("argon2 tagLength 3", () => argon2Sync("argon2id", rfc9106({ tagLength: 3 })));
record("argon2 fractional tagLength", () =>
	argon2Sync("argon2id", rfc9106({ tagLength: 1.5 })),
);
record("argon2 tagLength before memory", () =>
	argon2Sync("argon2id", rfc9106({ tagLength: 1, memory: 1 })),
);
record("argon2 memory below 8p", () =>
	argon2Sync("argon2id", rfc9106({ parallelism: 2, memory: 8 })),
);
record("argon2 memory floor mentions 8p", () =>
	argon2Sync("argon2id", rfc9106({ memory: 4294967296 })),
);
record("argon2 memory before passes", () =>
	argon2Sync("argon2id", rfc9106({ memory: 1, passes: 0 })),
);
record("argon2 passes 0", () => argon2Sync("argon2id", rfc9106({ passes: 0 })));
record("argon2 fractional passes", () =>
	argon2Sync("argon2id", rfc9106({ passes: 1.5 })),
);
record("argon2 string algorithm before parameters", () =>
	(argon2Sync as (...args: unknown[]) => unknown)(5, 5),
);

record("randomBytes fractional", () => randomBytes(1.5).length);
record("randomBytes 3.9", () => randomBytes(3.9).length);
record("randomBytes zero", () => randomBytes(0).length);
record("randomBytes numeric string", () =>
	(randomBytes as (...args: unknown[]) => unknown)("8"),
);
record("randomBytes null", () => (randomBytes as (...args: unknown[]) => unknown)(null));
record("randomBytes undefined", () =>
	(randomBytes as (...args: unknown[]) => unknown)(undefined),
);
record("randomBytes boolean", () =>
	(randomBytes as (...args: unknown[]) => unknown)(true),
);
record("randomBytes object", () => (randomBytes as (...args: unknown[]) => unknown)({}));
record("randomBytes negative", () => randomBytes(-1));
record("randomBytes NaN", () => randomBytes(NaN));
record("randomBytes Infinity", () => randomBytes(Infinity));
record("randomBytes 2^31", () => randomBytes(2147483648));
record("randomBytes non-function callback", () =>
	(randomBytes as (...args: unknown[]) => unknown)(16, 5),
);

// Node's argument-shape detection and its validation order, which are only
// observable when more than one argument is wrong at once: the callback is
// checked before the bounds, and an undefined `max` shifts the arguments down
// so the third one is ignored rather than treated as a callback.
record("randomInt bad callback beats bad bounds", () =>
	(randomInt as (...args: unknown[]) => unknown)(5, 4, 5),
);
record("randomInt bad callback beats bad min", () =>
	(randomInt as (...args: unknown[]) => unknown)(1.5, 5, 5),
);
record("randomInt bad callback beats an over-wide range", () =>
	(randomInt as (...args: unknown[]) => unknown)(0, 281474976710656, 5),
);
record("randomInt object callback beats bad bounds", () =>
	(randomInt as (...args: unknown[]) => unknown)(5, 4, {}),
);
record("randomInt bad min with a valid callback", () =>
	(randomInt as (...args: unknown[]) => unknown)(1.5, 5, () => undefined),
);
record("randomInt undefined max ignores a third argument", () =>
	Number.isInteger((randomInt as (...args: unknown[]) => number)(5, undefined, 5)),
);
record("randomInt undefined min", () =>
	(randomInt as (...args: unknown[]) => unknown)(undefined, 5),
);
record("randomInt fractional", () => randomInt(1.5));
record("randomInt numeric string", () =>
	(randomInt as (...args: unknown[]) => unknown)("5"),
);
record("randomInt unsafe integer", () => randomInt(Number.MAX_SAFE_INTEGER + 1));
record("randomInt max <= min", () => randomInt(5, 4));
record("randomInt equal bounds", () => randomInt(1, 1));
record("randomInt zero max", () => randomInt(0));
record("randomInt range too wide", () => randomInt(0, 281474976710656));
record("randomInt in range", () => {
	const value = randomInt(0, 10);
	return Number.isInteger(value) && value >= 0 && value < 10;
});
record("randomInt widest range", () => Number.isInteger(randomInt(0, 281474976710655)));
record("randomInt negative bounds", () => {
	const value = randomInt(-5, -1);
	return value >= -5 && value < -1;
});

record("randomUUID null options", () =>
	(randomUUID as (...args: unknown[]) => unknown)(null),
);
record("randomUUID numeric options", () =>
	(randomUUID as (...args: unknown[]) => unknown)(5),
);
record("randomUUID bad disableEntropyCache", () =>
	(randomUUID as (...args: unknown[]) => unknown)({ disableEntropyCache: 1 }),
);
record("randomUUID shape", () =>
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
		randomUUID(),
	),
);
record("randomUUID uncached shape", () =>
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
		randomUUID({ disableEntropyCache: true }),
	),
);

record("hash unknown encoding", () => hash("sha256", "abc", "bogus"));
record("hash numeric encoding", () =>
	(hash as (...args: unknown[]) => unknown)("sha256", "abc", 5),
);
record("hash null encoding", () =>
	(hash as (...args: unknown[]) => unknown)("sha256", "abc", null),
);

record("export lengths", () =>
	[argon2Sync.length, randomBytes.length, randomInt.length, randomUUID.length].join(","),
);
record("export names", () =>
	[argon2Sync.name, randomBytes.name, randomInt.name, randomUUID.name].join(","),
);

console.log(lines.join("\n"));
