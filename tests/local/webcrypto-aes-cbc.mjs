import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
const subtle = webcrypto.subtle;
const selection = process.env.MAL_TEST_AES_CBC_CASE;
const iv = Uint8Array.from({ length: 16 }, (_, i) => i);
const plaintext = iv.slice();
const importKey = (bytes, usages = ["encrypt", "decrypt"], algorithm = "AES-CBC") =>
	subtle.importKey("raw", bytes, algorithm, true, usages);
if (selection === "vectors") {
	for (const [length, expected] of [
		[16, "c6a13b37878f5b826f4f8162a1c8d879b1a29273be2c4207a5ace393398cb6fb"],
		[24, "916251821c73a522c396d627380196075f9d65297404307e9497f45625d5fd48"],
		[32, "f29000b62a499fd0a9f39a6add2e778053c8742d0ea29b2712f6c7af4048f4b4"],
	]) {
		const raw = Uint8Array.from({ length }, (_, i) => i);
		const key = await importKey(raw);
		assert.equal(key.algorithm.name, "AES-CBC");
		assert.equal(key.algorithm.length, length * 8);
		assert.deepEqual(Buffer.from(await subtle.exportKey("raw", key)), Buffer.from(raw));
		const parameters = { name: "aes-cbc", iv: new DataView(iv.buffer) };
		const encrypted = await subtle.encrypt(parameters, key, plaintext);
		assert.ok(encrypted instanceof ArrayBuffer);
		assert.equal(Buffer.from(encrypted).toString("hex"), expected);
		assert.deepEqual(
			Buffer.from(await subtle.decrypt(parameters, key, encrypted)),
			Buffer.from(plaintext),
		);
		const empty = await subtle.encrypt(parameters, key, new ArrayBuffer(0));
		assert.equal(empty.byteLength, 16);
		assert.equal((await subtle.decrypt(parameters, key, empty)).byteLength, 0);
	}
} else if (selection === "inputs") {
	const raw = Uint8Array.from({ length: 16 }, (_, i) => i);
	const key = await importKey(raw);
	raw.fill(0);
	const params = {
		name: "AES-CBC",
		iv: iv.slice(),
		get additionalData() {
			throw new Error("CBC ignores additionalData");
		},
		get tagLength() {
			throw new Error("CBC ignores tagLength");
		},
	};
	const input = plaintext.slice();
	const pending = subtle.encrypt(params, key, input);
	input.fill(0);
	params.iv.fill(0);
	const garbage = Array.from({ length: 1000 }, (_, index) => ({ index }));
	assert.equal(garbage[999].index, 999);
	assert.equal(
		Buffer.from(await pending).toString("hex"),
		"c6a13b37878f5b826f4f8162a1c8d879b1a29273be2c4207a5ace393398cb6fb",
	);
	const wrapOnly = await importKey(iv, ["wrapKey"]);
	wrapOnly.usages.push("encrypt");
	await assert.rejects(subtle.encrypt({ name: "AES-CBC", iv }, wrapOnly, plaintext), {
		name: "InvalidAccessError",
	});
	const gcm = await importKey(iv, ["encrypt", "decrypt"], "AES-GCM");
	const cipher = await subtle.encrypt(
		{
			name: "AES-GCM",
			iv,
			get tagLength() {
				return {
					get valueOf() {
						const garbage = Array.from({ length: 2000 }, (_, index) => ({ index }));
						assert.equal(garbage[1999].index, 1999);
						return () => "128.9";
					},
				};
			},
		},
		gcm,
		plaintext,
	);
	assert.deepEqual(
		Buffer.from(await subtle.decrypt({ name: "AES-GCM", iv }, gcm, cipher)),
		Buffer.from(plaintext),
	);
} else if (selection === "errors") {
	const key = await importKey(iv);
	await assert.rejects(importKey(new Uint8Array(15)), { name: "DataError" });
	await assert.rejects(importKey(iv, []), { name: "SyntaxError" });
	for (const length of [0, 15, 17])
		await assert.rejects(
			subtle.encrypt({ name: "AES-CBC", iv: new Uint8Array(length) }, key, plaintext),
			{ name: "OperationError" },
		);
	await assert.rejects(subtle.encrypt({ name: "AES-CBC" }, key, plaintext), TypeError);
	for (const length of [0, 15, 17])
		await assert.rejects(
			subtle.decrypt({ name: "AES-CBC", iv }, key, new Uint8Array(length)),
			{ name: "OperationError" },
		);
	const corrupted = Buffer.from(
		"c6a13b37878f5b826f4f8162a1c8d879b1a29273be2c4207a5ace393398cb600",
		"hex",
	);
	await assert.rejects(subtle.decrypt({ name: "AES-CBC", iv }, key, corrupted), {
		name: "OperationError",
	});
	await assert.rejects(subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext), {
		name: "InvalidAccessError",
	});
	const shared = new Uint8Array(new SharedArrayBuffer(16));
	await assert.rejects(importKey(shared), TypeError);
	await assert.rejects(
		subtle.encrypt({ name: "AES-CBC", iv: shared }, key, plaintext),
		TypeError,
	);
	await assert.rejects(subtle.encrypt({ name: "AES-CBC", iv }, key, shared), TypeError);
} else throw new Error(`Unknown case: ${selection}`);
console.log("WEBCRYPTO AES-CBC PASS");
