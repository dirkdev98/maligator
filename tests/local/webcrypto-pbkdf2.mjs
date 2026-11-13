import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
const subtle = webcrypto.subtle;
const selection = process.env.MAL_TEST_PBKDF2_CASE;
const bytes = (s) => new TextEncoder().encode(s);
const importPassword = (password = "password", usages = ["deriveBits"]) =>
	subtle.importKey("raw", bytes(password), "PBKDF2", false, usages);
const derive = (key, parameters = {}, length = 160) =>
	subtle.deriveBits(
		{ name: "PBKDF2", salt: bytes("salt"), iterations: 1, hash: "SHA-1", ...parameters },
		key,
		length,
	);
if (selection === "vectors") {
	for (const [password, salt, iterations, hash, length, expected] of [
		["password", "salt", 1, "SHA-1", 160, "0c60c80f961f0e71f3a9b524af6012062fe037a6"],
		[
			"password",
			"salt",
			"2.9",
			"SHA-256",
			"256.9",
			"ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43",
		],
		["", "", 1, "SHA-1", 160, "1e437a1c79d75be61e91141dae20affc4892cc99"],
	]) {
		const key = await importPassword(password, new Set(["deriveBits"]));
		assert.equal(key.algorithm.name, "PBKDF2");
		const result = await derive(key, { salt: bytes(salt), iterations, hash }, length);
		assert.ok(result instanceof ArrayBuffer);
		assert.equal(Buffer.from(result).toString("hex"), expected);
	}
	const key = await importPassword();
	assert.equal((await derive(key, { iterations: 4294967295 }, 0)).byteLength, 0);
} else if (selection === "snapshot") {
	const password = bytes("password");
	const salt = bytes("salt");
	const key = await subtle.importKey("raw", password, "PBKDF2", false, ["deriveBits"]);
	password.fill(0);
	const pending = subtle.deriveBits(
		{ name: "PBKDF2", salt, iterations: 1, hash: { name: "SHA-1" } },
		key,
		160,
	);
	salt.fill(0);
	const garbage = Array.from({ length: 1000 }, (_, index) => ({ index }));
	assert.equal(garbage[999].index, 999);
	assert.equal(
		Buffer.from(await pending).toString("hex"),
		"0c60c80f961f0e71f3a9b524af6012062fe037a6",
	);
	const deriveKeyOnly = await importPassword("password", ["deriveKey"]);
	deriveKeyOnly.usages.push("deriveBits");
	await assert.rejects(derive(deriveKeyOnly), { name: "InvalidAccessError" });
	Object.defineProperty(key, "extractable", { value: true });
	await assert.rejects(subtle.exportKey("raw", key), { name: "NotSupportedError" });
} else if (selection === "conversion") {
	const key = await importPassword();
	const order = [];
	const algorithm = {
		get name() {
			order.push("name");
			return "PBKDF2";
		},
		get hash() {
			order.push("hash");
			return {
				get name() {
					order.push("hash.name");
					return "SHA-1";
				},
			};
		},
		get iterations() {
			order.push("iterations");
			this.salt = bytes("salt");
			return 1;
		},
		salt: bytes("wrong"),
	};
	const result = await subtle.deriveBits(algorithm, key, {
		valueOf() {
			order.push("length");
			return 160;
		},
	});
	assert.equal(
		Buffer.from(result).toString("hex"),
		"0c60c80f961f0e71f3a9b524af6012062fe037a6",
	);
	assert.deepEqual(order, ["length", "name", "hash", "iterations", "hash.name"]);
	for (const buffer of [new SharedArrayBuffer(16)]) {
		for (const source of [buffer, new Uint8Array(buffer), new DataView(buffer)]) {
			await assert.rejects(
				subtle.importKey("raw", source, "PBKDF2", false, ["deriveBits"]),
				TypeError,
			);
			await assert.rejects(derive(key, { salt: source }), TypeError);
		}
	}
	const resizable = new ArrayBuffer(4, { maxByteLength: 16 });
	new Uint8Array(resizable).set(bytes("salt"));
	assert.equal(
		Buffer.from(await derive(key, { salt: new DataView(resizable) })).toString("hex"),
		"0c60c80f961f0e71f3a9b524af6012062fe037a6",
	);
} else if (selection === "errors") {
	await assert.rejects(
		subtle.importKey("raw", bytes("password"), "PBKDF2", true, ["deriveBits"]),
		{ name: "SyntaxError" },
	);
	await assert.rejects(importPassword("password", []), { name: "SyntaxError" });
	await assert.rejects(importPassword("password", ["encrypt"]), { name: "SyntaxError" });
	await assert.rejects(importPassword("password", ["invalid"]), TypeError);
	const key = await importPassword();
	for (const [parameters, length, name] of [
		[{ iterations: 0 }, 160, "OperationError"],
		[{ iterations: 2147483648 }, 160, "OperationError"],
		[{ iterations: -1 }, 160, "TypeError"],
		[{ iterations: NaN }, 160, "TypeError"],
		[{ salt: undefined }, 160, "TypeError"],
		[{ hash: undefined }, 160, "TypeError"],
		[{ hash: "invalid" }, 160, "NotSupportedError"],
		[{}, null, "OperationError"],
		[{}, 7, "OperationError"],
		[{}, -1, "TypeError"],
		[{}, Infinity, "TypeError"],
		[{}, 4294967296, "TypeError"],
	])
		await assert.rejects(derive(key, parameters, length), { name });
	await assert.rejects(
		subtle.deriveBits(
			{ name: "PBKDF2", salt: bytes("salt"), iterations: 1, hash: "SHA-1" },
			key,
		),
		{ name: "OperationError" },
	);
	await assert.rejects(subtle.sign("HMAC", key, bytes("message")), {
		name: "InvalidAccessError",
	});
} else throw new Error(`Unknown case: ${selection}`);
console.log("WEBCRYPTO PBKDF2 PASS");
