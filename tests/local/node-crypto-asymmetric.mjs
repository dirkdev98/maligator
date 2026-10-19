import crypto from "node:crypto";

const RSA_PRIVATE_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCcmletg+ITWuu3
CRAfhb9Zmo2qHia0ZO3krKahMtrT/xaB51j3EeDfYKTcbcQdOhwwQKRTUkOsKHAY
Gcpg4ZXioy2YJDkj/9qtlIzGHLF/qjQSa5+utHXFFqWxxQm72zmfGAzQqtt/6QBW
bp2Sdf1FslIzhHFrGloJo2qkkJi4KAJurkjwZJ9BJbQEsmV/Fw1tOz/E4RGiFVfk
OFOLrdKQSbQ8tVl8xWNNcQMQW7dzt1Nb/jAFHfNdL6kUlsFVLNNQvZv/ZnLy9nn3
PTIWCH2Ury0xpRVnjKpPC9/bJBdmSr9StxdFbdiwN9MJ98tD4RPudlzmssm1RcdT
dyRIhB9tAgMBAAECggEABpYoQg7wtdsxBvpYMFc4qy0IsHhtrNCCP/KyBx143jSV
pAI7Ypg2KCGsCsMJc1LpHMTElJDlHJXOfHkDOHbBzi3fok1DDlGkcdYJuLW8EnBH
GeTnFbBB3sz7IZe1ty4QhZw7l8AulLno+XmpYh+udsgPVIWJcVWC/Bz12d+PXiQX
FNT+J6AFobYNYJtwfNvPtnOZFgWbxT9xLfs2lhN8HNXimzOkSwfavM05vj70J+6e
Ad9Zt0OcXTvT1ssbkJLd832zPznKRhAAyPZvL448k15M/4OarS/sZfV8O1kmiHj4
6lIwSz40gZGx5twfP3SpG5mfu84JZo3i9WYned8YWQKBgQDZ8QgwBd9EgtajXXo9
yPrSdPJNzUUgFGGeGmFm3vYNz+4Z+eD9k5K0fZpRFSXEZly7JMS+tB0PJwPHw+dq
p6mhuQGwP6EJmxSDFBMhtCEg9b9Jf7ENQUEUDRUu+bYhnjmjXc4pX3ZiIESwWiRM
qzmgd0spcyo14X2NArqVBaIeqQKBgQC38zKMLXGOYBIlltoQktBCp2ywxhzDjjFw
Da26gOPdxEguisi0K/3lzVebs63n0zJun+A4lTZj+3UFAZ96Xv5hnTcOxv0Y7YwG
A3jOuqMEdT9+uiPQOkzlDJRbrxhLblmPvloj12KvvVa88COqeN5hVqwWTZuk3nWP
khIhrsvJJQKBgHaPTOjzCNZ4ZtNQUuOxpeE/hWEVvfkJnWEo8LvJpwk0iE7RRLgt
w600dvKNEpKZLPERu4YS7YwEqWXPCOFYfEtiHa0HsE9NcgcssIuxNiR8C6esM2EG
kqSZyWBYr9/x92EL8s9HA1u2OifFoeGjdCH7Q4Q1Bk1xcZ94UJApFFyhAoGAWiS/
vJn4cAD8Y5dNPZn0nPVW+jnblqlz6KmLXT4UbHTnuocgW8rDHX5HVHH04wpISJXo
V1In2U88xTtKX7l1h3h3prI1DaY7XCcPaJ9li6W5e+zT6BLp48UKXvOrQCvPj/WE
TtQZ9G0guG4lzEB3GdRTeIqHn3+0tKqsX/08uFECgYBj/haeChn+69CbqiFV4fsk
ZmHiaNpL4IzSJ840dRlk45Bsdqg7BGW15U60FK1747hQqGYY4+LoaCu25dhvRAS1
pxF5f3uMk2WaeoJXLeRH4C7ZC+BMbD/yXfJdrl+oxMvD8jKnDc4Q4ytYBCGgJVnb
AvFUe9ADcLhHDDPBZjoPcg==
-----END PRIVATE KEY-----
`;
const NODE_PSS_SIGNATURE =
	"Bd+Im5oBT1mJzdZbCftKruzhHab+I4aBwPTtky8qgxFygcrPky3QhuN3crIg3ffty1+xsQI8i66Fv0FNYlceLrf2VOYQe2yHi77ACSjmEVXDXhkL13784ODXaiK49Di5quBUxcYcdt7QznQZ08Cfp+8jzfecHrsmwmCEZyhgVmBWkd+ue9XgT1ar/64QXM4DSz3/Ft0mq/aIv5fK04dEYaU9KwBnV7z2v2o2vY/RZGVoLo63AqJCP6HcCQKxBbAG2rE+MvO2pa/thYJd80NEWiEJXHIdOGfwTZ1k/6Nx5PI8isVlVh2ANyV5i/adHaBx0nLvvjcXTkYTRpnx+3Vckw==";

const message = Buffer.from("the quick brown fox");

function attempt(label, fn) {
	try {
		console.log(label, fn());
	} catch (error) {
		console.log(label, "threw", error.name, error.code);
	}
}

function describeKey(label, key) {
	console.log(
		label,
		key.type,
		key.asymmetricKeyType,
		JSON.stringify(key.asymmetricKeyDetails ?? {}, (_k, v) =>
			typeof v === "bigint" ? `${v}n` : v,
		),
	);
}

const rsaPrivate = crypto.createPrivateKey(RSA_PRIVATE_PEM);
const rsaPublic = crypto.createPublicKey(rsaPrivate);
describeKey("rsa private", rsaPrivate);
describeKey("rsa public", rsaPublic);
console.log(
	"rsa pkcs8 round trip",
	rsaPrivate.export({ format: "pem", type: "pkcs8" }) === RSA_PRIVATE_PEM,
);
const pkcs1 = rsaPrivate.export({ format: "pem", type: "pkcs1" });
console.log("rsa pkcs1 label", pkcs1.split("\n")[0]);
console.log("rsa pkcs1 import equals", crypto.createPrivateKey(pkcs1).equals(rsaPrivate));
const spkiDer = rsaPublic.export({ format: "der", type: "spki" });
console.log(
	"rsa spki der",
	spkiDer.length,
	crypto.createPublicKey({ key: spkiDer, format: "der", type: "spki" }).equals(rsaPublic),
);
const rsaJwk = rsaPrivate.export({ format: "jwk" });
console.log("rsa jwk fields", Object.keys(rsaJwk).sort().join(","));
console.log(
	"rsa jwk import equals",
	crypto.createPrivateKey({ key: rsaJwk, format: "jwk" }).equals(rsaPrivate),
);
console.log("rsa public jwk", JSON.stringify(rsaPublic.export({ format: "jwk" })).length);

const rs256 = crypto
	.createSign("RSA-SHA256")
	.update("header.")
	.update("payload")
	.sign(RSA_PRIVATE_PEM, "base64");
console.log("rs256 signature", rs256);
console.log(
	"rs256 verify",
	crypto
		.createVerify("RSA-SHA256")
		.update("header.payload")
		.verify(rsaPublic, rs256, "base64"),
);
console.log(
	"rs256 verify tampered",
	crypto
		.createVerify("sha256")
		.update("header.payloaX")
		.verify(rsaPublic, rs256, "base64"),
);
for (const algorithm of ["sha384", "SHA512", "rsa-sha512"]) {
	const signature = crypto.sign(algorithm, message, rsaPrivate);
	console.log(
		"rsa",
		algorithm,
		signature.length,
		signature.subarray(0, 8).toString("hex"),
		crypto.verify(algorithm, message, rsaPublic, signature),
	);
}
console.log(
	"pss node signature",
	crypto.verify(
		"sha256",
		Buffer.from("pss message"),
		{
			key: rsaPublic,
			padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
			saltLength: 32,
		},
		Buffer.from(NODE_PSS_SIGNATURE, "base64"),
	),
);
const pss = crypto.sign("sha256", message, {
	key: rsaPrivate,
	padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
	saltLength: 32,
});
console.log(
	"pss round trip",
	pss.length,
	crypto.verify(
		"sha256",
		message,
		{
			key: rsaPublic,
			padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
			saltLength: 32,
		},
		pss,
	),
);

const hs256 = crypto
	.createHmac("sha256", "secret")
	.update("header.payload")
	.digest("base64url");
console.log("hs256", hs256);

for (const namedCurve of ["P-256", "secp384r1"]) {
	const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve });
	describeKey(`ec ${namedCurve} private`, privateKey);
	describeKey(`ec ${namedCurve} public`, publicKey);
	const hash = namedCurve === "P-256" ? "sha256" : "sha384";
	const der = crypto.sign(hash, message, privateKey);
	console.log("ecdsa der", der[0], crypto.verify(hash, message, publicKey, der));
	const p1363 = crypto.sign(hash, message, {
		key: privateKey,
		dsaEncoding: "ieee-p1363",
	});
	console.log(
		"ecdsa p1363",
		p1363.length,
		crypto.verify(hash, message, { key: publicKey, dsaEncoding: "ieee-p1363" }, p1363),
	);
	const pem = privateKey.export({ format: "pem", type: "pkcs8" });
	const sec1 = privateKey.export({ format: "pem", type: "sec1" });
	console.log("ec pem labels", pem.split("\n")[0], sec1.split("\n")[0]);
	console.log(
		"ec sec1 import equals",
		crypto.createPrivateKey(sec1).equals(privateKey),
		crypto.createPrivateKey(pem).equals(privateKey),
	);
	const jwk = privateKey.export({ format: "jwk" });
	console.log("ec jwk", jwk.kty, jwk.crv, Object.keys(jwk).sort().join(","));
	const fromJwk = crypto.createPublicKey({
		key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
		format: "jwk",
	});
	console.log("ec jwk public equals", fromJwk.equals(publicKey));
	const signer = crypto.createSign(hash).update(message);
	console.log(
		"ec createVerify",
		crypto
			.createVerify(hash)
			.update(message)
			.verify(fromJwk, signer.sign(crypto.createPrivateKey({ key: jwk, format: "jwk" }))),
	);
}

const pair = crypto.generateKeyPairSync("ed25519", {
	publicKeyEncoding: { format: "pem", type: "spki" },
	privateKeyEncoding: { format: "der", type: "pkcs8" },
});
console.log(
	"ed25519 encodings",
	typeof pair.publicKey,
	pair.publicKey.split("\n")[0],
	Buffer.isBuffer(pair.privateKey),
	pair.privateKey.length,
);
const edPrivate = crypto.createPrivateKey({
	key: pair.privateKey,
	format: "der",
	type: "pkcs8",
});
const edPublic = crypto.createPublicKey(pair.publicKey);
describeKey("ed25519 private", edPrivate);
const edSignature = crypto.sign(null, message, edPrivate);
console.log(
	"ed25519 sign",
	edSignature.length,
	crypto.verify(null, message, edPublic, edSignature),
);
console.log(
	"ed25519 deterministic",
	crypto.sign(undefined, message, edPrivate).equals(edSignature),
);
const fixedSeed = crypto.createPrivateKey({
	key: {
		kty: "OKP",
		crv: "Ed25519",
		d: "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A",
		x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
	},
	format: "jwk",
});
console.log(
	"ed25519 rfc8032 vector",
	crypto.sign(null, Buffer.alloc(0), fixedSeed).toString("hex"),
);
console.log(
	"ed25519 jwk",
	JSON.stringify(crypto.createPublicKey(fixedSeed).export({ format: "jwk" })),
);

attempt("bad key", () => crypto.createPrivateKey("not a key"));
attempt("bad digest", () => crypto.createSign("nope"));
attempt("public as private", () =>
	crypto.createSign("sha256").update("x").sign(rsaPublic),
);
attempt("createPrivateKey from public", () => crypto.createPrivateKey(rsaPublic));
attempt("ed25519 with digest", () =>
	crypto.createSign("sha256").update("x").sign(edPrivate),
);
attempt("unknown key type", () => crypto.generateKeyPairSync("dsa2", {}));
attempt("ec without curve", () => crypto.generateKeyPairSync("ec", {}));
console.log(
	"key prototypes",
	Object.getPrototypeOf(rsaPrivate).constructor.name,
	Object.getPrototypeOf(rsaPublic).constructor.name,
	rsaPrivate instanceof crypto.KeyObject,
);

const { Writable, Readable } = await import("node:stream");
const { types } = await import("node:util");
const streamSigner = crypto.createSign("RSA-SHA256");
console.log(
	"sign stream",
	streamSigner instanceof crypto.Sign,
	streamSigner instanceof Writable,
	crypto.Sign.length,
	crypto.Verify.name,
);
streamSigner.write("header.");
streamSigner.end("payload");
await new Promise((resolve) => streamSigner.on("finish", resolve));
console.log(
	"stream signature matches",
	streamSigner.sign(rsaPrivate, "base64") === rs256,
);
const streamVerifier = new crypto.Verify("sha256");
Readable.from([Buffer.from("header."), Buffer.from("payload")]).pipe(streamVerifier);
await new Promise((resolve) => streamVerifier.on("finish", resolve));
console.log("piped verify", streamVerifier.verify(rsaPublic, rs256, "base64"));
attempt("sign twice", () => streamSigner.sign(rsaPrivate));
console.log(
	"util.types",
	types.isKeyObject(rsaPublic),
	types.isKeyObject(crypto.createSecretKey(Buffer.alloc(4))),
	types.isKeyObject({}),
	types.isCryptoKey(rsaPublic),
);

console.log("generateKeyPair length", crypto.generateKeyPair.length);
attempt("generateKeyPair without callback", () => crypto.generateKeyPair("ed25519", {}));
attempt("generateKeyPair bad type", () => crypto.generateKeyPair("nope", {}, () => {}));
let callbackRan = false;
const generated = new Promise((resolve) =>
	crypto.generateKeyPair(
		"ec",
		{ namedCurve: "P-384", publicKeyEncoding: { format: "pem", type: "spki" } },
		(error, publicKey, privateKey) => {
			callbackRan = true;
			console.log(
				"generateKeyPair callback",
				error,
				typeof publicKey,
				publicKey.split("\n")[0],
				privateKey.asymmetricKeyType,
			);
			resolve();
		},
	),
);
console.log("generateKeyPair is async", callbackRan);
await generated;
await new Promise((resolve) =>
	crypto.generateKeyPair("ed25519", function (error, publicKey, privateKey) {
		console.log(
			"generateKeyPair two-argument form",
			error,
			publicKey.type,
			privateKey.type,
			arguments.length,
		);
		resolve();
	}),
);

const hmacKey = await crypto.subtle.importKey(
	"raw",
	Buffer.from("secret"),
	{ name: "HMAC", hash: "SHA-256" },
	true,
	["sign"],
);
const fromCryptoKey = crypto.KeyObject.from(hmacKey);
console.log(
	"KeyObject.from",
	fromCryptoKey.type,
	fromCryptoKey.symmetricKeySize,
	fromCryptoKey.export().toString(),
);
console.log(
	"util.types.isCryptoKey",
	types.isCryptoKey(hmacKey),
	types.isKeyObject(hmacKey),
);
attempt("KeyObject.from plain object", () => crypto.KeyObject.from({}));

const { subtle } = crypto.webcrypto;
console.log(
	"webcrypto global",
	globalThis.crypto === crypto.webcrypto,
	subtle instanceof SubtleCrypto,
	crypto.webcrypto instanceof Crypto,
	typeof CryptoKey,
	hmacKey instanceof CryptoKey,
);
const webRsaPrivate = await subtle.importKey(
	"jwk",
	rsaJwk,
	{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
	false,
	["sign"],
);
const webRsaPublic = await subtle.importKey(
	"spki",
	spkiDer,
	{ name: "RSASSA-PKCS1-v1_5", hash: { name: "SHA-256" } },
	true,
	["verify"],
);
console.log(
	"web rsa key",
	webRsaPrivate.type,
	webRsaPrivate.extractable,
	webRsaPrivate.algorithm.name,
	webRsaPrivate.algorithm.modulusLength,
	webRsaPrivate.algorithm.hash.name,
	webRsaPrivate.usages.join(","),
);
const webRs256 = Buffer.from(
	await subtle.sign("RSASSA-PKCS1-v1_5", webRsaPrivate, message),
);
console.log(
	"web rs256 matches node",
	webRs256.equals(crypto.sign("sha256", message, rsaPrivate)),
	await subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, webRsaPublic, webRs256, message),
);
const webPss = await subtle.importKey(
	"spki",
	spkiDer,
	{ name: "RSA-PSS", hash: "SHA-256" },
	false,
	["verify"],
);
console.log(
	"web pss node signature",
	await subtle.verify(
		{ name: "RSA-PSS", saltLength: 32 },
		webPss,
		Buffer.from(NODE_PSS_SIGNATURE, "base64"),
		Buffer.from("pss message"),
	),
);
const toCryptoKey = rsaPrivate.toCryptoKey(
	{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
	false,
	["sign"],
);
console.log(
	"toCryptoKey",
	toCryptoKey instanceof CryptoKey,
	toCryptoKey.type,
	Buffer.from(await subtle.sign("RSASSA-PKCS1-v1_5", toCryptoKey, message)).equals(
		webRs256,
	),
);
console.log(
	"KeyObject.from asymmetric",
	crypto.KeyObject.from(webRsaPublic).equals(rsaPublic),
);
const ecPair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
	"sign",
	"verify",
]);
console.log(
	"web ecdsa pair",
	ecPair.publicKey.usages.join(","),
	ecPair.privateKey.usages.join(","),
	ecPair.publicKey.algorithm.namedCurve,
	ecPair.publicKey.extractable,
);
const ecSignature = await subtle.sign(
	{ name: "ECDSA", hash: "SHA-256" },
	ecPair.privateKey,
	message,
);
const ecSpki = await subtle.exportKey("spki", ecPair.publicKey);
const ecImported = await subtle.importKey(
	"spki",
	ecSpki,
	{ name: "ECDSA", namedCurve: "P-256" },
	true,
	["verify"],
);
console.log(
	"web ecdsa",
	ecSignature.byteLength,
	await subtle.verify(
		{ name: "ECDSA", hash: "SHA-256" },
		ecImported,
		ecSignature,
		message,
	),
	crypto.verify(
		"sha256",
		message,
		{ key: crypto.KeyObject.from(ecImported), dsaEncoding: "ieee-p1363" },
		Buffer.from(ecSignature),
	),
);
const ecExported = await subtle.exportKey("jwk", ecPair.privateKey);
console.log(
	"web ecdsa jwk",
	Object.keys(ecExported).sort().join(","),
	ecExported.key_ops.join(","),
);
const edPublicRaw = await subtle.importKey(
	"raw",
	Buffer.from("11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo", "base64url"),
	{ name: "Ed25519" },
	true,
	["verify"],
);
console.log(
	"web ed25519 rfc8032",
	await subtle.verify(
		"Ed25519",
		edPublicRaw,
		crypto.sign(null, Buffer.alloc(0), fixedSeed),
		Buffer.alloc(0),
	),
);
const edPair = await subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
const edWebSignature = await subtle.sign({ name: "Ed25519" }, edPair.privateKey, message);
console.log(
	"web ed25519",
	edWebSignature.byteLength,
	await subtle.verify("Ed25519", edPair.publicKey, edWebSignature, message),
);
try {
	await subtle.exportKey("pkcs8", edPair.privateKey);
} catch (error) {
	console.log("web export non-extractable", error.name);
}
console.log(
	"web export raw secret",
	Buffer.from(await subtle.exportKey("raw", hmacKey)).toString(),
);
const ecRaw = Buffer.from(await subtle.exportKey("raw", ecPair.publicKey));
const ecFromRaw = await subtle.importKey(
	"raw",
	ecRaw,
	{ name: "ECDSA", namedCurve: "P-256" },
	true,
	["verify"],
);
console.log(
	"web ecdsa raw",
	ecRaw.length,
	ecRaw[0],
	await subtle.verify(
		{ name: "ECDSA", hash: "SHA-256" },
		ecFromRaw,
		ecSignature,
		message,
	),
);
console.log(
	"web ed25519 raw",
	Buffer.from(await subtle.exportKey("raw", edPublicRaw)).toString("base64url"),
);
