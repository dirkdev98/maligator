import { createHash, createHmac, pbkdf2Sync, timingSafeEqual } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import type { Server, Socket } from "node:net";
import { createServer as createTlsServer } from "node:tls";

export type PostgresAuthMode = "cleartext" | "md5" | "scram";

interface PostgresAuthPeer {
	port: number;
	close(): Promise<void>;
}

interface PostgresAuthPeerOptions {
	tls?: { certificate: string; key: string };
}

const password = "postgres";
const username = "postgres";
const md5Salt = Buffer.from([0x12, 0x34, 0x56, 0x78]);
const scramSalt = Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64");

function frame(type: string, body: Uint8Array = Buffer.alloc(0)): Buffer {
	const result = Buffer.allocUnsafe(body.length + 5);
	result[0] = type.charCodeAt(0);
	result.writeInt32BE(body.length + 4, 1);
	result.set(body, 5);
	return result;
}

function authentication(type: number, payload: Uint8Array = Buffer.alloc(0)): Buffer {
	const body = Buffer.allocUnsafe(payload.length + 4);
	body.writeInt32BE(type, 0);
	body.set(payload, 4);
	return frame("R", body);
}

function cstring(value: string): Buffer {
	return Buffer.from(`${value}\0`);
}

function startupComplete(): Buffer {
	const parameter = frame(
		"S",
		Buffer.concat([cstring("server_version"), cstring("16.0")]),
	);
	const backendKey = Buffer.allocUnsafe(8);
	backendKey.writeInt32BE(1234, 0);
	backendKey.writeInt32BE(5678, 4);
	return Buffer.concat([
		authentication(0),
		parameter,
		frame("K", backendKey),
		frame("Z", Buffer.from("I")),
	]);
}

function queryResult(): Buffer {
	const field = Buffer.allocUnsafe(19);
	field.writeInt32BE(0, 0);
	field.writeInt16BE(0, 4);
	field.writeInt32BE(23, 6);
	field.writeInt16BE(4, 10);
	field.writeInt32BE(-1, 12);
	field.writeInt16BE(0, 16);
	const description = Buffer.concat([
		Buffer.from([0, 1]),
		cstring("value"),
		field.subarray(0, 18),
	]);
	const row = Buffer.allocUnsafe(7);
	row.writeInt16BE(1, 0);
	row.writeInt32BE(1, 2);
	row[6] = 0x31;
	return Buffer.concat([
		frame("T", description),
		frame("D", row),
		frame("C", cstring("SELECT 1")),
		frame("Z", Buffer.from("I")),
	]);
}

function postgresMd5(): string {
	const inner = createHash("md5").update(`${password}${username}`).digest("hex");
	return `md5${createHash("md5")
		.update(Buffer.concat([Buffer.from(inner), md5Salt]))
		.digest("hex")}`;
}

function scramProof(clientFirstBare: string, serverFirst: string, clientFinal: string) {
	const salted = pbkdf2Sync(password, scramSalt, 4096, 32, "sha256");
	const authMessage = `${clientFirstBare},${serverFirst},${clientFinal}`;
	const clientKey = createHmac("sha256", salted).update("Client Key").digest();
	const storedKey = createHash("sha256").update(clientKey).digest();
	const signature = createHmac("sha256", storedKey).update(authMessage).digest();
	const proof = Buffer.allocUnsafe(clientKey.length);
	for (let i = 0; i < proof.length; i++) proof[i] = clientKey[i]! ^ signature[i]!;
	const serverKey = createHmac("sha256", salted).update("Server Key").digest();
	const serverSignature = createHmac("sha256", serverKey)
		.update(authMessage)
		.digest("base64");
	return { proof, serverSignature };
}

export async function startPostgresAuthPeer(
	mode: PostgresAuthMode,
	options: PostgresAuthPeerOptions = {},
): Promise<PostgresAuthPeer> {
	let failure: Error | undefined;
	const sockets = new Set<Socket>();
	const connection = (socket: Socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		let buffered = Buffer.alloc(0);
		let startup = true;
		let scramFirst = "";
		let scramServer = "";
		let authenticated = false;

		function fail(error: unknown): void {
			failure ??= error instanceof Error ? error : new Error(String(error));
			socket.destroy();
		}

		function handle(type: string, body: Buffer): void {
			if (authenticated) {
				if (type === "Q") socket.write(queryResult());
				else if (type === "X") socket.end();
				return;
			}
			if (type !== "p") throw new Error(`expected password message, received ${type}`);
			if (mode === "cleartext") {
				if (body.toString("utf8", 0, body.length - 1) !== password) {
					throw new Error("invalid cleartext password");
				}
				authenticated = true;
				socket.write(startupComplete());
				return;
			}
			if (mode === "md5") {
				if (body.toString("utf8", 0, body.length - 1) !== postgresMd5()) {
					throw new Error("invalid PostgreSQL MD5 response");
				}
				authenticated = true;
				socket.write(startupComplete());
				return;
			}
			if (scramFirst === "") {
				const zero = body.indexOf(0);
				if (body.toString("ascii", 0, zero) !== "SCRAM-SHA-256") {
					throw new Error("invalid SCRAM mechanism");
				}
				const length = body.readInt32BE(zero + 1);
				const first = body.toString("utf8", zero + 5, zero + 5 + length);
				if (!first.startsWith("n,,n=*,r="))
					throw new Error("invalid SCRAM client first message");
				scramFirst = first.slice(3);
				const nonce = scramFirst.slice("n=*,r=".length);
				scramServer = `r=${nonce}-server,s=${scramSalt.toString("base64")},i=4096`;
				socket.write(authentication(11, Buffer.from(scramServer)));
				return;
			}
			const final = body.toString("utf8");
			const proofIndex = final.lastIndexOf(",p=");
			if (proofIndex < 0) throw new Error("missing SCRAM proof");
			const withoutProof = final.slice(0, proofIndex);
			const provided = Buffer.from(final.slice(proofIndex + 3), "base64");
			const expected = scramProof(scramFirst, scramServer, withoutProof);
			if (
				provided.length !== expected.proof.length ||
				!timingSafeEqual(provided, expected.proof)
			) {
				throw new Error("invalid SCRAM proof");
			}
			authenticated = true;
			socket.write(
				Buffer.concat([
					authentication(12, Buffer.from(`v=${expected.serverSignature}`)),
					startupComplete(),
				]),
			);
		}

		socket.on("data", (chunk) => {
			try {
				buffered = Buffer.concat([
					buffered,
					typeof chunk === "string" ? Buffer.from(chunk) : chunk,
				]);
				while (buffered.length >= 4) {
					if (startup) {
						const length = buffered.readInt32BE(0);
						if (buffered.length < length) return;
						buffered = buffered.subarray(length);
						startup = false;
						if (mode === "cleartext") socket.write(authentication(3));
						else if (mode === "md5") socket.write(authentication(5, md5Salt));
						else socket.write(authentication(10, Buffer.from("SCRAM-SHA-256\0\0")));
						continue;
					}
					if (buffered.length < 5) return;
					const length = buffered.readInt32BE(1);
					if (buffered.length < length + 1) return;
					const type = buffered.toString("ascii", 0, 1);
					const body = buffered.subarray(5, length + 1);
					buffered = buffered.subarray(length + 1);
					handle(type, body);
				}
			} catch (error) {
				fail(error);
			}
		});
		socket.once("error", fail);
	};
	const server: Server = options.tls
		? createTlsServer(
				{
					ALPNProtocols: ["postgresql"],
					cert: options.tls.certificate,
					key: options.tls.key,
				},
				connection,
			)
		: createNetServer(connection);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string")
		throw new Error("missing peer port");
	return {
		port: address.port,
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
			if (failure !== undefined) throw failure;
		},
	};
}
