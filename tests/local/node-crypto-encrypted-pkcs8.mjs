import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createHttpsServer, get as httpsGet } from "node:https";
import { createServer, connect, createSecureContext } from "node:tls";
import {
	PASSWORD,
	SERVER_ENCRYPTED,
	SERVER_SHA1_ENCRYPTED,
	EMPTY_PASSWORD,
	CLIENT_ENCRYPTED,
} from "../fixtures/tls/encrypted-keys.mjs";
const selection = process.env.MAL_TEST_ENCRYPTED_KEY_CASE;
const fixture = (name) => readFileSync(`tests/fixtures/tls/${name}.pem`, "utf8");
if (selection === "crypto") {
	const plaintext = createPrivateKey(fixture("localhost-server-key"));
	const expected = plaintext.export({ type: "pkcs8", format: "der" });
	for (const [key, password] of [
		[SERVER_ENCRYPTED, PASSWORD],
		[Buffer.from(SERVER_ENCRYPTED), Buffer.from(PASSWORD)],
		[SERVER_SHA1_ENCRYPTED, PASSWORD],
		[EMPTY_PASSWORD, ""],
		[EMPTY_PASSWORD, Buffer.alloc(0)],
	]) {
		const imported = createPrivateKey({ key, passphrase: password });
		assert.deepEqual(imported.export({ type: "pkcs8", format: "der" }), expected);
		const signature = sign("sha256", Buffer.from("fictional message"), {
			key,
			passphrase: password,
		});
		const publicKey = createPublicKey({ key, passphrase: password });
		assert.equal(
			verify("sha256", Buffer.from("fictional message"), publicKey, signature),
			true,
		);
	}
	const der = Buffer.from(
		SERVER_ENCRYPTED.split("\n")
			.filter((line) => line && !line.startsWith("---"))
			.join(""),
		"base64",
	);
	assert.deepEqual(
		createPrivateKey({
			key: der,
			format: "der",
			type: "pkcs8",
			passphrase: PASSWORD,
		}).export({ type: "pkcs8", format: "der" }),
		expected,
	);
	assert.deepEqual(
		createPrivateKey({
			key: fixture("localhost-server-key"),
			passphrase: PASSWORD,
		}).export({ type: "pkcs8", format: "der" }),
		expected,
	);
	const imported = createPrivateKey({
		get key() {
			return Buffer.from(SERVER_ENCRYPTED);
		},
		get format() {
			const garbage = Array.from({ length: 1000 }, (_, i) => ({ i }));
			assert.equal(garbage[999].i, 999);
			return "pem";
		},
		get type() {
			return "pkcs8";
		},
		get passphrase() {
			return Buffer.from(PASSWORD);
		},
	});
	assert.deepEqual(imported.export({ type: "pkcs8", format: "der" }), expected);
} else if (selection === "errors") {
	assert.throws(() => createPrivateKey(SERVER_ENCRYPTED), {
		code: "ERR_OSSL_CRYPTO_INTERRUPTED_OR_CANCELLED",
	});
	assert.throws(() => createPrivateKey({ key: SERVER_ENCRYPTED, passphrase: "wrong" }), {
		code: "ERR_OSSL_BAD_DECRYPT",
	});
	for (const passphrase of [42, null, {}])
		assert.throws(() => createPrivateKey({ key: SERVER_ENCRYPTED, passphrase }), {
			code: "ERR_INVALID_ARG_VALUE",
		});
	assert.throws(
		() =>
			createSecureContext({
				key: SERVER_ENCRYPTED,
				cert: fixture("localhost-server-cert"),
				passphrase: "wrong",
			}),
		{ code: "ERR_OSSL_BAD_DECRYPT" },
	);
	for (const passphrase of [Buffer.from(PASSWORD), 42])
		assert.throws(
			() => createSecureContext({ key: fixture("localhost-server-key"), passphrase }),
			{ code: "ERR_INVALID_ARG_TYPE" },
		);
	assert.ok(
		createSecureContext({ key: fixture("localhost-server-key"), passphrase: null })
			.context,
	);
} else if (selection === "tls") {
	for (const key of [SERVER_ENCRYPTED, SERVER_SHA1_ENCRYPTED]) {
		const server = createServer(
			{
				key,
				cert: fixture("localhost-server-cert"),
				passphrase: PASSWORD,
				ca: fixture("client-ca-cert"),
				requestCert: true,
				rejectUnauthorized: true,
			},
			(socket) => {
				assert.equal(socket.authorized, true);
				socket.end("encrypted credentials");
			},
		);
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			for (const context of [false, true]) {
				const credentials = {
					key: CLIENT_ENCRYPTED,
					cert: fixture("client-cert"),
					passphrase: PASSWORD,
				};
				const text = await new Promise((resolve, reject) => {
					const socket = connect({
						port: server.address().port,
						host: "127.0.0.1",
						rejectUnauthorized: false,
						...(context
							? { secureContext: createSecureContext(credentials) }
							: credentials),
					});
					let body = "";
					socket.on("data", (chunk) => {
						body += chunk.toString();
					});
					socket.once("error", reject);
					socket.once("end", () => resolve(body));
				});
				assert.equal(text, "encrypted credentials");
			}
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	}
	const server = createHttpsServer(
		{
			key: SERVER_ENCRYPTED,
			cert: fixture("localhost-server-cert"),
			passphrase: PASSWORD,
			ca: fixture("client-ca-cert"),
			requestCert: true,
			rejectUnauthorized: true,
		},
		(_request, response) => response.end("encrypted https"),
	);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const text = await new Promise((resolve, reject) => {
			httpsGet(
				{
					hostname: "localhost",
					port: server.address().port,
					ca: fixture("localhost-cert"),
					key: CLIENT_ENCRYPTED,
					cert: fixture("client-cert"),
					passphrase: PASSWORD,
				},
				(response) => {
					let body = "";
					response.on("data", (chunk) => {
						body += chunk.toString();
					});
					response.once("error", reject);
					response.once("end", () => resolve(body));
				},
			).once("error", reject);
		});
		assert.equal(text, "encrypted https");
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
} else throw new Error(`Unknown case: ${selection}`);
console.log("ENCRYPTED PKCS8 PASS");
