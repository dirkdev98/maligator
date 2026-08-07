import { mkdtempSync } from "node:fs";
import { connect } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildNativeBinary, HOST_MAIN, withServer } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-fetch-hardening-"));

/**
 * Send raw bytes and collect everything the server writes back until it closes or
 * goes quiet. Node's fetch normalizes exactly the framing these tests are about, so
 * they speak the wire directly.
 */
function rawExchange(
	base: string,
	payload: string | Array<string | Buffer>,
	options: { quietMs?: number; destroyAfterFirstWrite?: boolean } = {},
): Promise<string> {
	const url = new URL(base);
	const writes = Array.isArray(payload) ? payload : [payload];
	const quietMs = options.quietMs ?? 250;
	return new Promise((resolve, reject) => {
		const socket = connect(Number(url.port), url.hostname);
		const chunks: Array<Buffer> = [];
		let quiet: NodeJS.Timeout | undefined;
		const settle = () => {
			clearTimeout(quiet);
			socket.destroy();
			resolve(Buffer.concat(chunks).toString("latin1"));
		};
		const bump = () => {
			clearTimeout(quiet);
			quiet = setTimeout(settle, quietMs);
		};
		socket.on("connect", () => {
			void (async () => {
				for (const write of writes) {
					if (socket.destroyed) break;
					socket.write(write);
					if (options.destroyAfterFirstWrite) {
						socket.destroy();
						resolve("");
						return;
					}
					if (writes.length > 1) {
						await new Promise<void>((done) => {
							setTimeout(done, 30);
						});
					}
				}
				bump();
			})().catch(reject);
		});
		socket.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
			bump();
		});
		socket.on("end", settle);
		socket.on("close", settle);
		// A refused upload closes the socket mid-write; the response already sent is
		// still what we want to assert on.
		socket.on("error", () => settle());
		setTimeout(() => reject(new Error("raw exchange timeout")), 15000).unref?.();
	});
}

function statusLine(response: string): string {
	return response.split("\r\n", 1)[0] ?? "";
}

// Defensive regressions for the Mal.serve transport. Each case asserts that a
// hostile or awkward message is *refused* or handled safely, and that the server
// keeps serving afterwards — never that some smuggled request becomes reachable.
describe("Mal.serve hardening", () => {
	let bin: string;
	beforeAll(() => {
		bin = buildNativeBinary({
			fixture: "tests/local/fetch_server_hardening.js",
			name: "fetch-hardening",
			mainFile: HOST_MAIN,
			outDir,
		});
	});

	// Mal.serve and node:http share one llhttp parser, so the ambiguous framing that
	// creates proxy differentials must be rejected here too, not just in the codec
	// unit test. These are single malformed messages, not a smuggling chain.
	it("rejects ambiguous request framing at the transport", async () => {
		await withServer(bin, {}, async (base) => {
			const conflicting = await rawExchange(
				base,
				"POST /len HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n" +
					"Transfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
			);
			expect(statusLine(conflicting)).toContain("400");

			const bareLf = await rawExchange(base, "GET /ok HTTP/1.1\nHost: x\n\n");
			expect(statusLine(bareLf)).toContain("400");

			const spaceBeforeColon = await rawExchange(
				base,
				"GET /ok HTTP/1.1\r\nHost : x\r\n\r\n",
			);
			expect(statusLine(spaceBeforeColon)).toContain("400");

			const obsFold = await rawExchange(
				base,
				"GET /ok HTTP/1.1\r\nHost: x\r\n X-Folded: y\r\n\r\n",
			);
			expect(statusLine(obsFold)).toContain("400");

			const duplicateLength = await rawExchange(
				base,
				"POST /len HTTP/1.1\r\nHost: x\r\nContent-Length: 1\r\n" +
					"Content-Length: 2\r\n\r\nab",
			);
			expect(statusLine(duplicateLength)).toContain("400");

			// The server is still healthy after every rejection.
			expect(await (await fetch(`${base}/ok`)).text()).toBe("ok");
		});
	});

	// The old in-place dechunker corrupted its own buffer when a body arrived in
	// pieces, turning a valid request into a 400.
	it("decodes a chunked body split across TCP writes", async () => {
		await withServer(bin, {}, async (base) => {
			const response = await rawExchange(base, [
				"POST /len HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n",
				"5\r\nHELLO\r\n",
				"6\r\n WORLD\r\n",
				"0\r\n\r\n",
			]);
			expect(statusLine(response)).toContain("200");
			expect(response).toContain("len=11");
		});
	});

	it("bounds the buffered request body", async () => {
		await withServer(bin, {}, async (base) => {
			// Declared past the 16 MiB cap: refused before any body byte is read.
			const declared = await rawExchange(
				base,
				"POST /len HTTP/1.1\r\nHost: x\r\nContent-Length: 33554432\r\n\r\n",
			);
			expect(statusLine(declared)).toContain("413");

			// A body under the cap still round-trips.
			const body = "z".repeat(64 * 1024);
			const accepted = await fetch(`${base}/len`, { method: "POST", body });
			expect(await accepted.text()).toBe(`len=${body.length}`);
		});
	});

	// The connection may be freed while a handler promise is still pending. Settling
	// onto a dead connection must be a no-op, not a use-after-free.
	it("survives a disconnect before the handler promise settles", async () => {
		await withServer(bin, {}, async (base) => {
			for (let i = 0; i < 8; i++) {
				await rawExchange(base, "GET /slow HTTP/1.1\r\nHost: x\r\n\r\n", {
					destroyAfterFirstWrite: true,
				});
			}
			// Give every abandoned promise time to settle onto its dead connection.
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 200);
			});
			expect(await (await fetch(`${base}/ok`)).text()).toBe("ok");

			// Same again, but abort through fetch so the request is fully framed first.
			await Promise.all(
				Array.from({ length: 4 }, async () => {
					const controller = new AbortController();
					const pending = fetch(`${base}/slow`, { signal: controller.signal });
					setTimeout(() => controller.abort(), 5);
					await pending.catch(() => undefined);
				}),
			);
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 200);
			});
			expect(await (await fetch(`${base}/ok`)).text()).toBe("ok");
		});
	});

	// request.url is composed from the Host header and the request target. It used to
	// be measured into a fixed stack buffer, so a long target read past its end.
	it("composes request.url exactly and refuses over-long targets", async () => {
		await withServer(bin, {}, async (base) => {
			const query = "q".repeat(4000);
			const target = `/url?${query}`;
			const response = await rawExchange(
				base,
				`GET ${target} HTTP/1.1\r\nHost: probe.test\r\nConnection: close\r\n\r\n`,
			);
			expect(statusLine(response)).toContain("200");
			const body = response.slice(response.indexOf("\r\n\r\n") + 4);
			expect(body).toBe(`http://probe.test${target}`);
			expect(body.length).toBe("http://probe.test".length + target.length);

			const tooLong = await rawExchange(
				base,
				`GET /url?${"q".repeat(9000)} HTTP/1.1\r\nHost: x\r\n\r\n`,
			);
			expect(statusLine(tooLong)).toContain("414");

			expect(await (await fetch(`${base}/ok`)).text()).toBe("ok");
		});
	});

	// A body where none is allowed shifts every following response on a reused
	// connection. Assert the wire carries no forbidden bytes and that the next
	// pipelined request still lines up.
	it("never sends a body for HEAD or an entity-forbidden status", async () => {
		await withServer(bin, {}, async (base) => {
			const head = await rawExchange(
				base,
				"HEAD /head HTTP/1.1\r\nHost: x\r\n\r\nGET /ok HTTP/1.1\r\nHost: x\r\n\r\n",
			);
			// HEAD mirrors what GET would advertise, but transmits nothing.
			expect(head).toMatch(/^HTTP\/1\.1 200[^\r]*\r\n/);
			expect(head.toLowerCase()).toContain("content-length: 8");
			expect(head).not.toContain("headbody");
			// The follow-up response is intact, so the response queue never shifted.
			const responses = head.split("HTTP/1.1 ").filter((part) => part.length > 0);
			expect(responses.length).toBe(2);
			expect(responses[1]).toContain("ok");

			const noContent = await rawExchange(
				base,
				"GET /no-content HTTP/1.1\r\nHost: x\r\n\r\nGET /ok HTTP/1.1\r\nHost: x\r\n\r\n",
			);
			expect(statusLine(noContent)).toContain("204");
			// RFC 9110: a 204 must not carry Content-Length.
			expect(
				noContent.slice(0, noContent.indexOf("\r\n\r\n")).toLowerCase(),
			).not.toContain("content-length");
			expect(noContent.split("HTTP/1.1 ").filter((p) => p.length > 0).length).toBe(2);

			const notModified = await rawExchange(
				base,
				"GET /not-modified HTTP/1.1\r\nHost: x\r\n\r\nGET /ok HTTP/1.1\r\nHost: x\r\n\r\n",
			);
			expect(statusLine(notModified)).toContain("304");
			expect(
				notModified.slice(0, notModified.indexOf("\r\n\r\n")).toLowerCase(),
			).not.toContain("content-length");
			expect(notModified.split("HTTP/1.1 ").filter((p) => p.length > 0).length).toBe(2);
		});
	});
});
