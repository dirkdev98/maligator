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

// tests/fixtures/tls: a localhost CA, the server certificate it issued, its key, and an EC client certificate.
const X509_CA = `-----BEGIN CERTIFICATE-----
MIIDHzCCAgegAwIBAgIULVaV44pPF1s2X4nIQVnkQ4gncQwwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDcyNzIwMTQwNVoXDTM2MDcy
NDIwMTQwNVowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAugrG62LEZPIE0jvdNCQ1ewHN//t5XP1N8Nf9Bgepdbme
KUi/GbyQsMFYWaPPjLB4iEYPYFfBJ+HL4F3bYB37623e7027OYapo5hMiGwGHBGY
+HeFWaii1dMQWZ4FG+UZ0BXik+xR/InI/4vVCsU3c203WIGS89TrQ//6cnOmAsVZ
NXMBBIEA4sQybe7Np9BF6cnBirSqVySZm2sQv9X5l46lmGP3fgN9qdkj8hHmFms4
7NroYeuMonSkVbYKBiSCLNX6eU/P28mnWrX0tA+CNVnl6+mEAjlRJWye3dHlaPZa
hix9ygVOI39yHP/JvsCbT+Lf/QFHq/w2uhrb1By/EQIDAQABo2kwZzAdBgNVHQ4E
FgQUTmWkC3KciaaTX/Ixp1nQ1h71T1MwHwYDVR0jBBgwFoAUTmWkC3KciaaTX/Ix
p1nQ1h71T1MwDwYDVR0TAQH/BAUwAwEB/zAUBgNVHREEDTALgglsb2NhbGhvc3Qw
DQYJKoZIhvcNAQELBQADggEBAJvXM3BD+2roJIkg92dS3OzvtH1Y66ELLOsILjiT
Ezbx5bV5nc1yjybIhLU3eMuyarvXN/iwwKXbx6I4YrrIr7W35ZqlKWCiFJS4nivz
8M3t/RFX47gg6iclZs1DuvueWvwdrNU03UHxZ+gQYY6E86eTgpAXYSgJS2nGZqA2
QYSmRKz42+wFRwP1BftXt09ir5FmYbf4txAZDk7gj3XeiYk3g4+gNDHlCnYOMU6X
rpnz81gR4MniuDNqNTI+o6G0E7pPoCrMg9gxvztk62aecuNiM+sAh1FZeOgWcSuQ
pDa8gW5gZetuCUL0n2D7cqbUBMXAQhhzrXMTAHHTXawHiNs=
-----END CERTIFICATE-----
`;
const X509_SERVER = `-----BEGIN CERTIFICATE-----
MIIDPTCCAiWgAwIBAgIUAKMihiwk4GFZURFNOuv3qe1ercswDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDcyNzIwMjExNloXDTM2MDcy
NDIwMjExNlowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEA0C5Nflog96InamL2eDzDqN7nwP+t/RXYmYaHMyteqfQ9
3XQthDJV83CVyOeKKZVdk33Xvz6iAJemAFX1A5O+tUqVSwHnzm485Vl9ft+7zjaf
mZW+Lzl/jELfyzRfgt1BfoRn4cXHW15OWmIxBHYdPp4F22dXYNTeJAkpJrqbA4Xh
3MnLP9VjNKrR2EQoO8lfzRrfAM1edJvA/JJ3K/Fz6GE75MqU/ledAZse6loMuD+F
B3kETySVFbwweEa3zkDnCaSI26YLDP155Dhnrz0E0O0RFmq5nhAZqrINa319eyp/
h4MrMpxgk/4OtK2oF4SvbjhUNhSlqZPd/QCDI2O0XQIDAQABo4GGMIGDMBQGA1Ud
EQQNMAuCCWxvY2FsaG9zdDAJBgNVHRMEAjAAMAsGA1UdDwQEAwIFoDATBgNVHSUE
DDAKBggrBgEFBQcDATAdBgNVHQ4EFgQU2k6PyDIyt5yUfedSSssAZ3eJb9owHwYD
VR0jBBgwFoAUTmWkC3KciaaTX/Ixp1nQ1h71T1MwDQYJKoZIhvcNAQELBQADggEB
ALPzLUWd9J7f86BOo3GI1j+E38rKZ+YDPLFjs7TdHwCfc12yLHfnybvr+0N8WLpI
qodjDGwti/qkDe5ury8dfzrrDK+gtjWyY3e4rLTnARbrHgVvNsU7W8l9Z/Ym6RxJ
tvV4iYTf+s5JxFG5SjDi9AemnB+v9FPlTJtOla2PY3jdSShEZ16h3FfvVffzFnuh
EJ5JoUudcwMdL7Q5zJs9a4uSegyNDbC3EoyvJtu8Fiho5F1YuPg5kcDbsHFqP7vR
pCkYDc5++7/RNlsknlCo5aTDChq8Wg/WsM//3lVsIsDd4nvQsKEzR+j0Hk1Z4062
hcwKmXmF37fwjB2/JO/0WU8=
-----END CERTIFICATE-----
`;
const X509_SERVER_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDQLk1+WiD3oidq
YvZ4PMOo3ufA/639FdiZhoczK16p9D3ddC2EMlXzcJXI54oplV2Tfde/PqIAl6YA
VfUDk761SpVLAefObjzlWX1+37vONp+Zlb4vOX+MQt/LNF+C3UF+hGfhxcdbXk5a
YjEEdh0+ngXbZ1dg1N4kCSkmupsDheHcycs/1WM0qtHYRCg7yV/NGt8AzV50m8D8
kncr8XPoYTvkypT+V50Bmx7qWgy4P4UHeQRPJJUVvDB4RrfOQOcJpIjbpgsM/Xnk
OGevPQTQ7REWarmeEBmqsg1rfX17Kn+HgysynGCT/g60ragXhK9uOFQ2FKWpk939
AIMjY7RdAgMBAAECggEALu2FG/qqrE/CBVYWG7AM5hQLV4L7QE4Mo70C3JrF7ddI
G9PMz9w96lDCfwWMrEeGjtEjEXIHuEz3B2PZBauoJXtQ0JX3IF5SvVuRMciy7+75
xrgN5VzXfvFzO74MWrZQBXpI5Yi9IgBN9stkI86RVJRwGw9+T65kfeiPvXJ6r431
qI0P3J7XGorDP3xaSpQG98C6pFA6/rxHbQGdAfsQhpfyYCIAs3kWmeutiluc8jCi
1m5FFhBnnTeOeOo0kf6knxMhv+67q6X6usl/fkGo9lZaDdLvq1scwx/3cENMsYZg
oGnnQ9De9CSx/PFjkRNwASJLp9cURAKbMlYyN2rH0QKBgQD/hOIvaV/PAJWJvcoT
tU2gAnL8f1+kA80Lmldt4acTjxhXcJHSs7H63D0iVnvrbw9s39EJxOql8xDKRy7z
GX1YRBJl6bNfljNi16LxPAt3Guj1f9gk9soJ3jlXjvJNfwhb9sZLQoBghev7hXhD
ebl6GKUeVmYMAGIQy5huPsADbQKBgQDQkpw594TPrEf0RIF1Ff5VH/K7tdznQePK
UyHjTMajx8SlL5J59l1AHimJtKEN65TiwovQpqDI+KuwxBajUJIKBsUL9AgwrOz9
8sgrh5UV2Vf5z8h+lJI7YEa+ArkikSHazl7u5/MXYiRjljh9h/1vFt3B6aIc9m9K
+mPbWfrusQKBgQCj5WODz85ho9lHWdJlo9SfvxJsfXMmbD24pI5R7/zQIegWJiGT
CiouY9hezyR7VmiJiGK4JnPwcCGj7dbincX1uOwoLKgetuRNEU31+HLOOheVaSSG
STo87CrRy+IF7Wa6Pmbg3U4lG6HLWshSV6Ct/WLkO70HE7PTXBRxGpTlXQKBgGqI
F+e7t0hjlLT9MKpfO3K7SL373AL6sqCq6YoxstwAsz40GDrXTTXssga2DfUQORHB
kKxYD5PW/8rfvThZdN5OKuM6F9zU1o+3K+qf69QnGTptmNiehjpxqHBw76LqQkKC
Whbovk9ZP4DmP6BOj3HoWggrjzP/40SGs+5b/UFhAoGBAJXCBc5UmpvVUJPT/m63
ktYxaqcxn0QiVpnsM/Zug7Gc0PHU4EalsrOEfjXf4b4aHPbXLIvS3/9F2+ej5wwy
jHkmY8jH2C/sOc+wbUincCUcOfHQDn6Dr8iKenKiSSEBLtfcrBdLDvpcz0KbwRTk
Z29mJJ2qyw8fQwtM1g8cNba/
-----END PRIVATE KEY-----
`;
const X509_CLIENT = `-----BEGIN CERTIFICATE-----
MIIBczCCARigAwIBAgIULLg5xQM7FRSQvUdDFaoCsHVxShAwCgYIKoZIzj0EAwIw
IzEhMB8GA1UEAwwYTWFsaWdhdG9yIFRlc3QgQ2xpZW50IENBMB4XDTI2MTAxOTIx
MzIzOFoXDTM2MTAxNjIxMzIzOFowGzEZMBcGA1UEAwwQbWFsaWdhdG9yLWNsaWVu
dDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABNBSLNLfAcPTBP0CCXkYA5Cr0lwx
DLm3O95uOfYnVuulZdYAArfDPXiYgO+r4gMLDOua8YNoQn2WzkHNZI95H9SjMjAw
MAkGA1UdEwQCMAAwDgYDVR0PAQH/BAQDAgeAMBMGA1UdJQQMMAoGCCsGAQUFBwMC
MAoGCCqGSM49BAMCA0kAMEYCIQDNVaWwfVumDCMyDd1alM6D6tMkAozVhKcVlf8k
C7I5eAIhAPuiJTnxR2UUpfIx1H4dkUysB1Yyk6lCwnMwAFcnMEJY
-----END CERTIFICATE-----
`;

const x509Server = new crypto.X509Certificate(X509_SERVER);
const x509Ca = new crypto.X509Certificate(Buffer.from(X509_CA));
const x509Client = new crypto.X509Certificate(
	new crypto.X509Certificate(X509_CLIENT).raw,
);
for (const [label, certificate] of [
	["server", x509Server],
	["ca", x509Ca],
	["client", x509Client],
]) {
	console.log(
		"x509",
		label,
		JSON.stringify({
			subject: certificate.subject,
			issuer: certificate.issuer,
			subjectAltName: certificate.subjectAltName,
			infoAccess: certificate.infoAccess,
			validFrom: certificate.validFrom,
			validTo: certificate.validTo,
			validFromDate: certificate.validFromDate.toISOString(),
			validToDate: certificate.validToDate.toISOString(),
			serialNumber: certificate.serialNumber,
			fingerprint: certificate.fingerprint,
			fingerprint256: certificate.fingerprint256,
			fingerprint512: certificate.fingerprint512,
			ca: certificate.ca,
			keyUsage: certificate.keyUsage,
			signatureAlgorithm: certificate.signatureAlgorithm,
			signatureAlgorithmOid: certificate.signatureAlgorithmOid,
			raw: certificate.raw.length,
			publicKey: [certificate.publicKey.type, certificate.publicKey.asymmetricKeyType],
		}),
	);
}
console.log(
	"x509 pem",
	x509Server.toString() === X509_SERVER,
	x509Server.toJSON() === X509_SERVER,
	x509Server.raw === x509Server.raw,
);
console.log(
	"x509 checks",
	x509Server.checkHost("localhost"),
	x509Server.checkHost("LOCALHOST"),
	x509Server.checkHost("example.com"),
	x509Server.checkEmail("a@example.com"),
	x509Server.checkIP("127.0.0.1"),
	x509Server.checkIssued(x509Ca),
	x509Ca.checkIssued(x509Server),
	x509Server.verify(x509Ca.publicKey),
	x509Server.verify(x509Server.publicKey),
	x509Client.verify(x509Ca.publicKey),
	x509Server.checkPrivateKey(crypto.createPrivateKey(X509_SERVER_KEY)),
);
const legacy = x509Server.toLegacyObject();
console.log(
	"x509 legacy",
	JSON.stringify(legacy.subject),
	JSON.stringify(legacy.issuer),
	legacy.subjectaltname,
	legacy.ca,
	legacy.valid_from,
	legacy.fingerprint256 === x509Server.fingerprint256,
	JSON.stringify(legacy.ext_key_usage),
	legacy.serialNumber,
	legacy.raw.length,
);
for (const input of ["not a certificate", 5, new ArrayBuffer(4)]) {
	try {
		new crypto.X509Certificate(input);
		console.log("x509 accepted", typeof input);
	} catch (error) {
		console.log("x509 rejected", error.code);
	}
}

for (const [type, options] of [
	["hmac", { length: 8 }],
	["hmac", { length: 9 }],
	["hmac", { length: 512 }],
	["aes", { length: 128 }],
	["aes", { length: 256 }],
	["hmac", { length: 7 }],
	["hmac", { length: 8.5 }],
	["hmac", { length: 2 ** 31 }],
	["hmac", {}],
	["aes", { length: 100 }],
	["aes", { length: "128" }],
	["xyz", { length: 128 }],
	[5, { length: 128 }],
	["hmac", null],
]) {
	try {
		const key = crypto.generateKeySync(type, options);
		console.log(
			"generateKeySync",
			type,
			key.type,
			key.symmetricKeySize,
			key instanceof crypto.KeyObject,
		);
	} catch (error) {
		console.log("generateKeySync", String(type), error.code, error.message);
	}
}
const generatedSecret = await new Promise((resolve, reject) =>
	crypto.generateKey("aes", { length: 192 }, (error, key) =>
		error ? reject(error) : resolve(key),
	),
);
console.log(
	"generateKey",
	generatedSecret.type,
	generatedSecret.symmetricKeySize,
	generatedSecret.export().length,
);
try {
	crypto.generateKey("aes", { length: 192 });
} catch (error) {
	console.log("generateKey callback", error.code);
}
console.log(
	"digest classes",
	typeof crypto.Hash,
	typeof crypto.Hmac,
	crypto.Hash.length,
	crypto.Hmac.length,
	crypto.createHash("sha256") instanceof crypto.Hash,
	crypto.createHmac("sha256", "k") instanceof crypto.Hmac,
	crypto.createHmac("sha256", "k") instanceof crypto.Hash,
	crypto.createHash("sha256").constructor === crypto.Hash,
	new crypto.Hash("sha1").update("x").digest("hex"),
	crypto.Hmac("sha256", "k").update("x").digest("hex"),
);

{
	const { Readable, Writable, Transform } = await import("node:stream");
	const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
	const hash = crypto.createHash("sha256");
	const events = [];
	// TODO: add "prefinish" and "close" once node:stream Transforms emit them.
	for (const name of ["data", "end", "finish"]) {
		hash.on(name, (chunk) =>
			events.push(chunk ? `${name}:${chunk.toString("hex").slice(0, 8)}` : name),
		);
	}
	hash.write("ab");
	hash.end("c");
	await settle();
	console.log("hash stream events", events.join(" "));

	const encoded = crypto.createHash("sha256");
	encoded.setEncoding("hex");
	const piped = [];
	Readable.from(["a", "b", "c"])
		.pipe(encoded)
		.on("data", (chunk) => piped.push(chunk));
	await settle();
	console.log("hash pipe", piped.join(""));

	const finalized = crypto.createHash("sha256");
	finalized.digest();
	const order = [];
	finalized.on("error", (error) => order.push(`error ${error.code} ${error.message}`));
	finalized.write("x", (error) => order.push(`callback ${error && error.code}`));
	await settle();
	console.log("hash write after digest", order.join(" | "));

	const hmac = crypto.createHmac("sha256", "k");
	const hmacChunks = [];
	hmac.on("data", (chunk) => hmacChunks.push(chunk));
	hmac.end("abc");
	await settle();
	console.log("hmac stream data", Buffer.concat(hmacChunks).toString("hex").slice(0, 16));

	const key = Buffer.alloc(16, 1);
	const iv = Buffer.alloc(16, 2);
	const plain = [];
	await new Promise((resolve) =>
		Readable.from([Buffer.from("hello "), Buffer.from("world")])
			.pipe(crypto.createCipheriv("aes-128-cbc", key, iv))
			.pipe(crypto.createDecipheriv("aes-128-cbc", key, iv))
			.on("data", (chunk) => plain.push(chunk))
			.on("end", resolve),
	);
	console.log("cipher pipe roundtrip", Buffer.concat(plain).toString());
	const broken = crypto.createDecipheriv("aes-128-cbc", key, iv);
	const brokenError = new Promise((resolve) =>
		broken.on("error", (error) => resolve(error instanceof Error)),
	);
	broken.end(Buffer.alloc(16));
	console.log("decipher stream error", await brokenError);

	const fresh = crypto.createHash("sha256");
	console.log(
		"lazy transform",
		Object.keys(fresh).includes("_readableState"),
		fresh instanceof Transform,
		crypto.createHmac("sha256", "k") instanceof Transform,
		crypto.createCipheriv("aes-128-cbc", key, iv) instanceof Transform,
		crypto.createDecipheriv("aes-128-cbc", key, iv) instanceof Transform,
		crypto.createSign("sha256") instanceof Writable,
		fresh.update("abc").digest("hex").slice(0, 16),
	);
}
