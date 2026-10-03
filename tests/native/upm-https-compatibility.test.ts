import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	HOST_MAIN,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(join(tmpdir(), "mal-upm-https-"));
const fixture = "tests/local/upm-https-compatibility.mjs";
const ca = resolve("tests/fixtures/tls/localhost-cert.pem");
const malformed = join(outDir, "malformed.pem");
let binaries: Array<string>;
let optionsBinary: string;
beforeAll(() => {
	writeFileSync(malformed, "not a certificate");
	optionsBinary = buildNativeBinary({
		fixture: "tests/local/upm-https-options.mjs",
		name: "options",
		mainFile: HOST_MAIN,
		outDir,
		nodeEnabled: true,
	});
	binaries = [true, false].map((compiled) =>
		buildNativeBinary({
			fixture,
			name: compiled ? "compiled" : "interpreted",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
			webPlatformEnabled: true,
			compiled,
		}),
	);
}, 180000);
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
async function run(
	binary: string,
	mode: string,
	stress = false,
	args: Array<string> = [],
): Promise<string> {
	const sockets = new Set<Socket>();
	const server = createServer(
		{
			cert: readFileSync("tests/fixtures/tls/localhost-server-cert.pem"),
			key: readFileSync("tests/fixtures/tls/localhost-server-key.pem"),
		},
		(request, response) => {
			response.on("error", () => {});
			if (request.url === "/options") {
				response.end("options-ok");
				return;
			}
			if (request.url === "/never") {
				return;
			}
			if (request.url === "/slow") {
				response.write("first");
				return;
			}
			response.setHeader("Content-Type", "application/octet-stream");
			const body = "verified-body-".repeat(24000);
			let offset = 0;
			const send = () => {
				if (response.destroyed) return;
				while (offset < body.length) {
					const chunk = body.slice(offset, offset + 1537);
					offset += chunk.length;
					if (!response.write(chunk)) {
						response.once("drain", send);
						return;
					}
				}
				response.end();
			};
			send();
		},
	);
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	server.on("tlsClientError", () => {});
	await new Promise<void>((yes, no) => {
		server.on("error", no);
		server.listen(0, "127.0.0.1", yes);
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("missing port");
	try {
		return await new Promise<string>((yes, no) => {
			execFile(
				binary,
				args,
				{
					encoding: "utf8",
					timeout: 10000,
					env: {
						...process.env,
						...(stress ? STRESS_ENV : {}),
						MAL_HTTPS_PORT: String(address.port),
						MAL_HTTPS_EXPECT_FAIL: mode,
						NODE_EXTRA_CA_CERTS:
							mode === "trust" ? "" : mode === "malformed" ? malformed : ca,
					},
				},
				(error, stdout, stderr) =>
					error ? no(new Error(`${error.message}\n${stdout}\n${stderr}`)) : yes(stdout),
			);
		});
	} finally {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((yes) => {
			server.close(() => yes());
		});
	}
}
it("streams verified HTTPS and cancels responses in both backends", async () => {
	expect(await run(process.execPath, "", false, [fixture])).toContain(
		"HTTPS STREAM ABORT PASS",
	);
	for (const binary of binaries)
		expect(await run(binary, "")).toContain("HTTPS STREAM ABORT PASS");
});
it("keeps TLS transport, response and abort state alive under GC stress", async () => {
	expect(await run(binaries[0]!, "", true)).toContain("HTTPS STREAM ABORT PASS");
});
it("rejects unknown roots, mismatched hostnames and malformed extra CA configuration", async () => {
	for (const mode of ["trust", "hostname", "malformed"]) {
		expect(await run(process.execPath, mode, false, [fixture])).toContain(
			"HTTPS REJECTION PASS",
		);
		expect(await run(binaries[0]!, mode)).toContain("HTTPS REJECTION PASS");
	}
});

it("refuses unsupported security overrides and custom agents", async () => {
	const output = await new Promise<string>((resolve, reject) => {
		execFile(
			optionsBinary,
			[],
			{ encoding: "utf8", timeout: 5000 },
			(error, stdout, stderr) =>
				error ? reject(new Error(stdout + stderr)) : resolve(stdout),
		);
	});
	assertResultPass(output);
});
