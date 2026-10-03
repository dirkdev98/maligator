import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(join(tmpdir(), "mal-http-reuse-"));
const fixture = "tests/local/upm-http-reuse.mjs";
let binaries: Array<string>;
let recordBinary: string;
beforeAll(() => {
	binaries = [true, false].map((compiled) =>
		buildNativeBinary({
			fixture,
			name: compiled ? "compiled" : "interpreted",
			outDir,
			mainFile: HOST_MAIN,
			nodeEnabled: true,
			evalEnabled: false,
			realmsEnabled: false,
			intlEnabled: false,
			temporalEnabled: false,
			compiled,
		}),
	);
	recordBinary = buildNativeBinary({
		fixture,
		name: "record-driver",
		outDir,
		mainFile: "tests/fixtures/upm-http-tls-record-driver.c",
		nodeEnabled: true,
		evalEnabled: false,
		realmsEnabled: false,
		intlEnabled: false,
		temporalEnabled: false,
	});
}, 180000);
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

async function run(binary: string, secure: boolean, stress = false, ttl = false) {
	const sockets = new Set<Socket>();
	const ids = new WeakMap<Socket, number>();
	let connections = 0;
	const extraCa = join(outDir, `ca-${secure}-${stress}-${ttl}.pem`);
	writeFileSync(extraCa, readFileSync(resolve("tests/fixtures/tls/localhost-cert.pem")));
	const listener = (request: IncomingMessage, response: ServerResponse) => {
		const id = ids.get(request.socket)!;
		const body = String(id);
		if (request.url === "/connection") {
			response.end(`${body}:${request.headers.connection}`);
			return;
		}
		if (request.url === "/dirty") {
			request.socket.write(
				`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n${body}UNSOLICITED`,
			);
			return;
		}
		if (request.url === "/eof") {
			request.socket.end(`HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n${body}`);
			return;
		}
		if (request.url === "/abort") {
			response.write(body);
			return;
		}
		if (request.url === "/server-close") response.setHeader("Connection", "close");
		if (request.url === "/stale") setTimeout(() => request.socket.destroy(), 10);
		if (request.url === "/chunked") {
			response.write(body);
			response.end();
			return;
		}
		if (request.url === "/upload") {
			let length = 0;
			request.on("data", (chunk: Buffer) => {
				length += chunk.length;
			});
			request.on("end", () => response.end(`${body}:${length}`));
			return;
		}
		response.end(body);
	};
	const server = secure
		? createHttpsServer(
				{
					cert: readFileSync("tests/fixtures/tls/localhost-server-cert.pem"),
					key: readFileSync("tests/fixtures/tls/localhost-server-key.pem"),
				},
				listener,
			)
		: createHttpServer(listener);
	server.keepAliveTimeout = 15000;
	server.on(secure ? "secureConnection" : "connection", (socket: Socket) => {
		ids.set(socket, ++connections);
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	server.on("tlsClientError", () => {});
	await new Promise<void>((yes, no) => {
		server.once("error", no);
		server.listen(0, "127.0.0.1", yes);
	});
	const address = server.address();
	if (address === null || typeof address === "string")
		throw new Error("missing server address");
	const start = Date.now();
	const other = createHttpServer((_request, response) => response.end("other-origin"));
	await new Promise<void>((yes) => {
		other.listen(0, "127.0.0.1", yes);
	});
	const otherAddress = other.address();
	if (otherAddress === null || typeof otherAddress === "string")
		throw new Error("missing other origin");
	try {
		const stdout = await new Promise<string>((yes, no) => {
			execFile(
				binary,
				[],
				{
					timeout: 12000,
					encoding: "utf8",
					env: {
						...process.env,
						...(stress ? STRESS_ENV : {}),
						MAL_REUSE_SECURE: secure ? "1" : "0",
						MAL_REUSE_PORT: String(address.port),
						MAL_REUSE_OTHER_PORT: secure ? "" : String(otherAddress.port),
						MAL_REUSE_TTL: ttl ? "1" : "0",
						MAL_REUSE_POLICY: secure ? "1" : "0",
						NODE_EXTRA_CA_CERTS: extraCa,
					},
				},
				(error, stdout, stderr) =>
					error ? no(new Error(`${error.message}\n${stdout}\n${stderr}`)) : yes(stdout),
			);
		});
		assertResultPass(stdout);
		expect(Date.now() - start).toBeLessThan(11000);
	} finally {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((yes) => {
			server.close(() => yes());
		});
		other.closeAllConnections();
		await new Promise<void>((yes) => {
			other.close(() => yes());
		});
	}
}

it("reuses clean HTTP and verified TLS exchanges without retaining idle event-loop work", async () => {
	for (const secure of [false, true]) await run(binaries[0]!, secure);
});
it("preserves the transport lifecycle under GC stress and interpreted execution", async () => {
	for (const secure of [false, true]) await run(binaries[0]!, secure, true);
	await run(binaries[1]!, false);
});
it("expires idle transports before checkout", async () => {
	await run(binaries[0]!, false, false, true);
});
it("rejects partial ciphertext records and isolates exact verified TLS policies", () => {
	assertResultPass(runToStdout(recordBinary));
});
