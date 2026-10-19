import {
	Cipheriv,
	Decipheriv,
	KeyObject,
	createCipheriv,
	createDecipheriv,
	getCipherInfo,
	getCiphers,
	constants,
	createHash,
	createHmac,
	createSecretKey,
	getHashes,
	getRandomValues,
	hkdf,
	hkdfSync,
	pbkdf2,
	pbkdf2Sync,
	randomFill,
	randomFillSync,
	randomUUIDv7,
	scrypt,
	scryptSync,
	subtle,
	webcrypto,
} from "node:crypto";

function report(label, fn) {
	try {
		console.log(label, fn());
	} catch (error) {
		console.log(label, "throws", error.name, error.code, error.message);
	}
}

const hex = (value) => Buffer.from(value).toString("hex");

const filled = new Uint8Array(8);
console.log("randomFillSync returns target", randomFillSync(filled, 2, 4) === filled);
console.log("randomFillSync window", filled[0], filled[1], filled[6], filled[7]);
const words = new Uint32Array(4);
randomFillSync(words, 1, 2);
console.log("randomFillSync elements", words[0], words[3]);
randomFillSync(new DataView(new ArrayBuffer(4)));
randomFillSync(new ArrayBuffer(4));
report("randomFillSync offset", () => randomFillSync(new Uint8Array(4), 5));
report("randomFillSync size", () => randomFillSync(new Uint8Array(4), 1, 4));
report("randomFillSync type", () => randomFillSync("x"));

const values = new Uint16Array(4);
console.log("getRandomValues returns target", getRandomValues(values) === values);
report("getRandomValues float", () => getRandomValues(new Float32Array(2)));
report("getRandomValues quota", () => getRandomValues(new Uint8Array(70000)));

const v7 = randomUUIDv7();
console.log(
	"randomUUIDv7",
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v7),
	Math.abs(parseInt(v7.replaceAll("-", "").slice(0, 12), 16) - Date.now()) < 60000,
);

console.log(
	"pbkdf2Sync",
	pbkdf2Sync("password", "salt", 4096, 20, "sha256").toString("hex"),
);
console.log("scryptSync default", scryptSync("pw", "salt", 16).toString("hex"));
console.log(
	"scryptSync aliases",
	scryptSync("password", "NaCl", 32, {
		cost: 1024,
		blockSize: 8,
		parallelization: 16,
	}).toString("hex"),
);
report("scryptSync N", () => scryptSync("a", "b", 16, { N: 3 }));
report("scryptSync maxmem", () => scryptSync("a", "b", 16, { N: 1 << 20 }));
const okm = hkdfSync("sha256", "key", "salt", "info", 42);
console.log("hkdfSync", okm instanceof ArrayBuffer, hex(okm));
console.log("hkdfSync sha512", hex(hkdfSync("sha512", Buffer.from("key"), "", "", 16)));
report("hkdfSync keylen", () => hkdfSync("sha256", "k", "s", "i", 255 * 32 + 1));
report("hkdfSync digest", () => hkdfSync("nope", "k", "s", "i", 4));
report("pbkdf2 callback", () => pbkdf2("p", "s", 1, 8, "sha256"));
report("pbkdf2 iterations", () => pbkdf2("p", "s", 0, 8, "sha256", () => {}));

const order = [];
await new Promise((resolve) => {
	let pending = 4;
	const done = () => --pending === 0 && resolve();
	pbkdf2("password", "salt", 1, 32, "sha256", (error, key) => {
		order.push(`pbkdf2 ${error} ${key.toString("hex")}`);
		done();
	});
	scrypt("pw", "salt", 16, { N: 1024 }, (error, key) => {
		order.push(`scrypt ${error} ${key.toString("hex")}`);
		done();
	});
	hkdf("sha256", "key", "salt", "info", 16, (error, key) => {
		order.push(`hkdf ${error} ${key instanceof ArrayBuffer} ${hex(key)}`);
		done();
	});
	const target = Buffer.alloc(4);
	randomFill(target, 1, 2, (error, buffer) => {
		order.push(`randomFill ${error} ${buffer === target} ${buffer[0]} ${buffer[3]}`);
		done();
	});
	order.push("sync first");
});
console.log(order.sort().join("\n"));

console.log("getHashes", getHashes().includes("sha256"), getHashes().includes("sha512"));
console.log(
	"constants",
	constants.RSA_PKCS1_PADDING,
	constants.TLS1_3_VERSION,
	typeof constants.defaultCipherList,
);

const secret = createSecretKey(Buffer.from("abc"));
console.log(
	"secret key",
	secret.type,
	secret.symmetricKeySize,
	secret.export().toString(),
	secret instanceof KeyObject,
	Object.prototype.toString.call(secret),
	secret.asymmetricKeyType,
);
console.log("secret key jwk", JSON.stringify(secret.export({ format: "jwk" })));
console.log("secret key hex string", createSecretKey("616263", "hex").equals(secret));
console.log("secret key hmac", createHmac("sha256", secret).update("x").digest("hex"));
console.log("secret key hkdf", hex(hkdfSync("sha256", secret, "salt", "info", 8)));
report("KeyObject constructor", () => new KeyObject());

console.log("webcrypto", webcrypto.subtle === subtle, typeof webcrypto.getRandomValues);
console.log("subtle digest", hex(await subtle.digest("sha-256", new Uint8Array([1, 2]))));
console.log(
	"subtle digest object",
	hex(await subtle.digest({ name: "SHA-512" }, Buffer.from("abc"))).slice(0, 32),
);
await subtle
	.digest("MD5", new Uint8Array(1))
	.catch((error) => console.log("subtle md5", error.name, error.message));
await subtle
	.digest("SHA-1", "x")
	.catch((error) => console.log("subtle data", error.name, error.code));

const hmacKey = await subtle.importKey(
	"raw",
	Buffer.from("key"),
	{ name: "HMAC", hash: "SHA-256" },
	false,
	["sign", "verify"],
);
console.log(
	"subtle key",
	hmacKey.type,
	hmacKey.extractable,
	JSON.stringify(hmacKey.algorithm),
	JSON.stringify(hmacKey.usages),
	Object.prototype.toString.call(hmacKey),
);
const signature = await subtle.sign("HMAC", hmacKey, Buffer.from("data"));
console.log("subtle sign", hex(signature));
console.log(
	"subtle verify",
	await subtle.verify({ name: "HMAC" }, hmacKey, signature, Buffer.from("data")),
	await subtle.verify("HMAC", hmacKey, new Uint8Array(32), Buffer.from("data")),
);

const key16 = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
const key24 = Buffer.concat([key16, key16.subarray(0, 8)]);
const key32 = Buffer.concat([key16, key16]);
const iv16 = Buffer.from("f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff", "hex");
const iv12 = iv16.subarray(0, 12);
const plaintext =
	"The quick brown fox jumps over the lazy dog, twice: The quick brown fox.";
console.log(
	"ciphers",
	getCiphers()
		.filter((name) => /^(aes-(128|192|256)-(cbc|ctr|gcm)|chacha20-poly1305)$/.test(name))
		.join(),
);
for (const name of ["aes-128-cbc", "aes-256-gcm", "chacha20-poly1305", "aes-192-ctr"]) {
	console.log("cipher info", JSON.stringify(getCipherInfo(name)));
}
console.log("cipher info unknown", getCipherInfo("nope"));
for (const [name, key] of [
	["aes-128-cbc", key16],
	["aes-192-cbc", key24],
	["aes-256-cbc", key32],
	["aes-128-ctr", key16],
	["aes-256-ctr", key32],
]) {
	const cipher = createCipheriv(name, key, iv16);
	const encrypted =
		cipher.update(plaintext.slice(0, 7), "utf8", "hex") +
		cipher.update(plaintext.slice(7), "utf8", "hex") +
		cipher.final("hex");
	const decipher = createDecipheriv(name, key, iv16);
	const decrypted =
		decipher.update(encrypted.slice(0, 34), "hex", "utf8") +
		decipher.update(encrypted.slice(34), "hex", "utf8") +
		decipher.final("utf8");
	console.log("cipher", name, encrypted, decrypted === plaintext);
}
const base64Cipher = createCipheriv("aes-128-cbc", key16, iv16);
console.log(
	"cipher base64",
	JSON.stringify(base64Cipher.update("hello world, this is a test", "utf8", "base64")),
	base64Cipher.final("base64"),
);
const unpadded = createCipheriv("aes-128-cbc", key16, iv16).setAutoPadding(false);
console.log(
	"cipher nopad",
	Buffer.concat([unpadded.update(Buffer.alloc(32, 7)), unpadded.final()]).toString("hex"),
);
for (const [name, key, iv] of [
	["aes-128-gcm", key16, iv12],
	["aes-192-gcm", key24, iv12],
	["aes-256-gcm", key32, iv12],
	["aes-128-gcm", key16, iv16],
	["chacha20-poly1305", key32, iv12],
]) {
	const cipher = createCipheriv(name, key, iv, { authTagLength: 16 });
	cipher.setAAD(Buffer.from("header"), { plaintextLength: plaintext.length });
	const encrypted = Buffer.concat([
		cipher.update(plaintext.slice(0, 20)),
		cipher.update(plaintext.slice(20)),
		cipher.final(),
	]);
	const tag = cipher.getAuthTag();
	const decipher = createDecipheriv(name, key, iv, { authTagLength: 16 });
	decipher.setAAD(Buffer.from("header"), { plaintextLength: plaintext.length });
	decipher.setAuthTag(tag);
	const decrypted = Buffer.concat([
		decipher.update(encrypted),
		decipher.final(),
	]).toString();
	console.log(
		"aead",
		name,
		iv.length,
		encrypted.toString("hex"),
		tag.toString("hex"),
		decrypted === plaintext,
	);
	const forged = createDecipheriv(name, key, iv);
	forged.setAAD(Buffer.from("header"));
	forged.setAuthTag(Buffer.alloc(16));
	forged.update(encrypted);
	report("aead forged", () => forged.final());
}
const shortTag = createCipheriv("aes-128-gcm", key16, iv12, { authTagLength: 8 });
shortTag.update("abc");
shortTag.final();
console.log("aead short tag", shortTag.getAuthTag().toString("hex"));
console.log(
	"cipher classes",
	createCipheriv("aes-128-ctr", key16, iv16) instanceof Cipheriv,
	createDecipheriv("aes-128-ctr", key16, iv16) instanceof Decipheriv,
);
console.log(
	"cipher keyobject",
	createCipheriv("aes-128-ctr", createSecretKey(key16), iv16)
		.update("abc")
		.toString("hex"),
);
report("cipher keylen", () => createCipheriv("aes-128-cbc", Buffer.alloc(5), iv16));
report("cipher ivlen", () => createCipheriv("aes-128-cbc", key16, Buffer.alloc(5)));
report("cipher unknown", () => createCipheriv("aes-128-xyz", key16, iv16));
report("cipher nopad partial", () => {
	const cipher = createCipheriv("aes-128-cbc", key16, iv16);
	cipher.setAutoPadding(false);
	cipher.update("abc");
	return cipher.final();
});
report("decipher bad decrypt", () => {
	const decipher = createDecipheriv("aes-128-cbc", key16, iv16);
	decipher.update(Buffer.alloc(16));
	return decipher.final();
});
report("decipher wrong final", () => {
	const decipher = createDecipheriv("aes-128-cbc", key16, iv16);
	decipher.update(Buffer.alloc(5));
	return decipher.final();
});
report("gcm without tag", () => {
	const decipher = createDecipheriv("aes-128-gcm", key16, iv12);
	decipher.update(Buffer.alloc(5));
	return decipher.final();
});
report("gcm early tag", () => createCipheriv("aes-128-gcm", key16, iv12).getAuthTag());
report("gcm tag length", () =>
	createCipheriv("aes-128-gcm", key16, iv12, { authTagLength: 7 }),
);
report("gcm set tag length", () =>
	createDecipheriv("aes-128-gcm", key16, iv12).setAuthTag(Buffer.alloc(5)),
);
report("cbc aad", () =>
	createCipheriv("aes-128-cbc", key16, iv16).setAAD(Buffer.alloc(1)),
);
report("chacha iv", () => createCipheriv("chacha20-poly1305", key32, Buffer.alloc(8)));
report("update after final", () => {
	const cipher = createCipheriv("aes-128-ctr", key16, iv16);
	cipher.final();
	return cipher.update("a");
});

for (const digest of [
	"md5",
	"sha1",
	"sha224",
	"sha256",
	"sha384",
	"sha512",
	"SHA-256",
	"RSA-SHA1",
]) {
	console.log(
		"digest",
		digest,
		createHash(digest).update("abc").digest("hex").slice(0, 24),
		createHmac(digest, "key").update("abc").digest("base64"),
		pbkdf2Sync("password", "salt", 3, 40, digest).toString("hex"),
	);
}
console.log(
	"hmac long key",
	createHmac("sha512", Buffer.alloc(200, 1)).update("abc").digest("hex").slice(0, 32),
);
report("createHmac unknown", () => createHmac("not-a-hash", "key"));
report("pbkdf2Sync unknown", () => pbkdf2Sync("p", "s", 1, 8, "not-a-hash"));
await new Promise((resolve) =>
	pbkdf2("password", "salt", 2, 24, "sha512", (error, key) => {
		console.log("pbkdf2 sha512", error, key.toString("hex"));
		resolve();
	}),
);

const aesKey = await subtle.importKey("raw", key16, "AES-GCM", true, [
	"encrypt",
	"decrypt",
]);
console.log(
	"subtle aes key",
	JSON.stringify(aesKey.algorithm),
	aesKey.extractable,
	JSON.stringify(aesKey.usages),
);
const sealed = await subtle.encrypt(
	{ name: "AES-GCM", iv: iv12, additionalData: Buffer.from("aad") },
	aesKey,
	Buffer.from("hello"),
);
console.log("subtle encrypt", sealed instanceof ArrayBuffer, hex(sealed));
console.log(
	"subtle encrypt tag96",
	hex(
		await subtle.encrypt(
			{ name: "AES-GCM", iv: iv12, tagLength: 96 },
			aesKey,
			Buffer.from("hello"),
		),
	),
);
console.log(
	"subtle decrypt",
	Buffer.from(
		await subtle.decrypt(
			{ name: "AES-GCM", iv: iv12, additionalData: Buffer.from("aad") },
			aesKey,
			sealed,
		),
	).toString(),
);
await subtle
	.decrypt({ name: "AES-GCM", iv: iv12 }, aesKey, sealed)
	.catch((error) => console.log("subtle decrypt forged", error.name, error.message));
await subtle
	.importKey("raw", Buffer.alloc(5), "AES-GCM", true, ["encrypt"])
	.catch((error) => console.log("subtle aes keylen", error.name, error.message));
await subtle
	.encrypt({ name: "AES-GCM", iv: iv12, tagLength: 100 }, aesKey, Buffer.from("x"))
	.catch((error) => console.log("subtle aes tag", error.name, error.message));
await subtle
	.encrypt({ name: "AES-GCM", iv: iv12 }, hmacKey, Buffer.from("x"))
	.catch((error) => console.log("subtle aes mismatch", error.name, error.message));
