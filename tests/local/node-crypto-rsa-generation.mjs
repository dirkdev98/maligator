import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import {
	createPrivateKey,
	createPublicKey,
	generateKeyPair,
	generateKeyPairSync,
	sign,
	verify,
} from "node:crypto";

const selection = process.env.MAL_TEST_RSA_CASE;

function checkPair(publicKey, privateKey, bits, exponent) {
	assert.equal(publicKey.asymmetricKeyType, "rsa");
	assert.equal(privateKey.type, "private");
	assert.equal(publicKey.asymmetricKeyDetails.modulusLength, bits);
	assert.equal(publicKey.asymmetricKeyDetails.publicExponent, BigInt(exponent));
	assert.equal(createPublicKey(privateKey).equals(publicKey), true);
	const der = privateKey.export({ format: "der", type: "pkcs1" });
	const restored = createPrivateKey({ key: der, format: "der", type: "pkcs1" });
	assert.equal(restored.equals(privateKey), true);
	const jwk = privateKey.export({ format: "jwk" });
	assert.equal(createPrivateKey({ key: jwk, format: "jwk" }).equals(privateKey), true);
}

if (selection === "sync") {
	for (const publicExponent of [65537, 3]) {
		const { publicKey, privateKey } = generateKeyPairSync("rsa", {
			modulusLength: 1024,
			publicExponent,
			publicKeyEncoding: null,
			privateKeyEncoding: null,
		});
		checkPair(publicKey, privateKey, 1024, publicExponent);
	}
	const pair = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicKeyEncoding: { type: "spki", format: "der" },
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
	});
	const publicKey = createPublicKey({ key: pair.publicKey, type: "spki", format: "der" });
	const privateKey = createPrivateKey(pair.privateKey);
	checkPair(publicKey, privateKey, 2048, 65537);
	const message = Buffer.from("generated RSA key");
	assert.equal(
		verify("sha256", message, publicKey, sign("sha256", message, privateKey)),
		true,
	);
} else if (selection === "node-import") {
	const privateKey = createPrivateKey(process.env.MAL_TEST_RSA_NODE_PRIVATE);
	checkPair(createPublicKey(privateKey), privateKey, 1024, 65537);
} else if (selection === "async") {
	const storage = new AsyncLocalStorage();
	const options = {
		modulusLength: 2048,
		publicKeyEncoding: { type: "spki", format: "pem" },
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
	};
	let returned = false;
	const completed = storage.run(
		"key-generation",
		() =>
			new Promise((resolve, reject) => {
				generateKeyPair("rsa", options, function (error, publicPem, privatePem) {
					try {
						assert.equal(returned, true);
						assert.equal(arguments.length, 3);
						assert.equal(error, null);
						assert.equal(storage.getStore(), "key-generation");
						assert.equal(typeof publicPem, "string");
						assert.equal(typeof privatePem, "string");
						checkPair(
							createPublicKey(publicPem),
							createPrivateKey(privatePem),
							2048,
							65537,
						);
						resolve();
					} catch (failure) {
						reject(failure);
					}
				});
			}),
	);
	options.modulusLength = 1024;
	options.publicKeyEncoding.format = "der";
	options.privateKeyEncoding.type = "pkcs1";
	returned = true;
	const garbage = Array.from({ length: 1000 }, (_, index) => ({ index }));
	assert.equal(garbage[999].index, 999);
	await completed;
} else if (selection === "invalid") {
	for (const options of [
		{},
		{ modulusLength: "1024" },
		{ modulusLength: 1024.5 },
		{ modulusLength: -1 },
		{ modulusLength: 1024, publicExponent: "3" },
		{ modulusLength: 1024, publicExponent: 3.5 },
		{ modulusLength: 1024, publicKeyEncoding: { type: "spki", format: "invalid" } },
	]) {
		assert.throws(() => generateKeyPairSync("rsa", options));
		assert.throws(() => generateKeyPair("rsa", options, () => {}));
	}
	assert.throws(() =>
		generateKeyPairSync("rsa", { modulusLength: 1024, publicExponent: 2 }),
	);
	await new Promise((resolve, reject) => {
		generateKeyPair(
			"rsa",
			{ modulusLength: 1024, publicExponent: 2 },
			function (error, publicKey, privateKey) {
				try {
					assert.equal(arguments.length, 1);
					assert.ok(error instanceof Error);
					assert.equal(publicKey, undefined);
					assert.equal(privateKey, undefined);
					resolve();
				} catch (failure) {
					reject(failure);
				}
			},
		);
	});
} else {
	throw new Error(`Unknown case: ${selection}`);
}
console.log("RSA GENERATION PASS");
