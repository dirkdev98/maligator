import { mkdtempSync } from "node:fs";
import { connect } from "node:net";
import type { Socket } from "node:net";
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
	let limitsBin: string;
	beforeAll(() => {
		bin = buildNativeBinary({
			fixture: "tests/local/fetch_server_hardening.js",
			name: "fetch-hardening",
			mainFile: HOST_MAIN,
			outDir,
		});
		limitsBin = buildNativeBinary({
			fixture: "tests/local/fetch_server_limits.js",
			name: "fetch-limits",
			mainFile: HOST_MAIN,
			outDir,
		});
	});

	// The transport bounds used to be reachable only from the native test main, so a
	// JS application had no way to tighten them. Zero still selects the engine
	// default for each field — a bound can be retuned but never switched off.
	it("applies validated Mal.serve transport limits", async () => {
		await withServer(limitsBin, {}, async (base) => {
			const url = new URL(base);
			const open = (): Promise<Socket> =>
				new Promise((resolve, reject) => {
					const socket = connect(Number(url.port), url.hostname);
					socket.once("connect", () => resolve(socket));
					socket.once("error", reject);
				});
			const collect = (socket: Socket, quietMs: number): Promise<string> =>
				new Promise((resolve) => {
					const chunks: Array<Buffer> = [];
					const timer = setTimeout(() => {
						socket.destroy();
						resolve(Buffer.concat(chunks).toString("latin1"));
					}, quietMs);
					socket.on("data", (chunk: Buffer) => chunks.push(chunk));
					socket.on("error", () => undefined);
					socket.once("close", () => {
						clearTimeout(timer);
						resolve(Buffer.concat(chunks).toString("latin1"));
					});
				});

			const held = await open();
			held.write("GET /limits HTTP/1.1\r\nHost: x\r\n\r\n");
			const body = collect(held, 3000);
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 100);
			});

			// maxConnections: 1 — the slot is taken, so this socket is dropped unread.
			const refused = await open();
			expect(await collect(refused, 1500)).toBe("");

			// keepAliveTimeout: 400 — well under the 5s engine default, so an idle
			// reusable connection is reaped inside the collect window above.
			const response = await body;
			expect(response).toContain("HTTP/1.1 200");
			expect(response.slice(response.indexOf("\r\n\r\n") + 4)).toBe(
				"TypeError,TypeError,TypeError,TypeError,TypeError,TypeError",
			);
			expect(held.destroyed).toBe(true);
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

	// request.url is the origin the application authorizes against. Anything that
	// could make it parse as a different origin than the bytes on the wire — or that
	// leaves two Host fields for a proxy and the application to disagree over — is
	// refused before a handler ever sees it.
	it("validates the Host header as a single URI authority", async () => {
		await withServer(bin, {}, async (base) => {
			const rejected = [
				"Host: probe.test/evil",
				"Host: probe.test#evil",
				"Host: probe.test?evil",
				"Host: user@probe.test",
				"Host: probe test",
				"Host: probe.test:",
				"Host: probe.test:0x50",
				"Host: probe.test:99999",
				"Host: [::1",
				"Host: ::1",
				"Host: probe\ttest",
				"Host:",
			];
			for (const header of rejected) {
				const response = await rawExchange(
					base,
					`GET /url HTTP/1.1\r\n${header}\r\nConnection: close\r\n\r\n`,
				);
				expect(statusLine(response), header).toContain("400");
			}

			// Duplicate Host is refused on every version, so no proxy/application
			// split is possible — not even where HTTP/1.0 permits a missing field.
			const duplicate11 = await rawExchange(
				base,
				"GET /url HTTP/1.1\r\nHost: a.test\r\nHost: b.test\r\n\r\n",
			);
			expect(statusLine(duplicate11)).toContain("400");
			const duplicate10 = await rawExchange(
				base,
				"GET /url HTTP/1.0\r\nHost: a.test\r\nHost: b.test\r\n\r\n",
			);
			expect(statusLine(duplicate10)).toContain("400");

			// A missing HTTP/1.0 Host keeps the localhost fallback; the bound URL and
			// the composed URL are the same selection in every accepted case.
			const legacy = await rawExchange(base, "GET /url HTTP/1.0\r\n\r\n");
			expect(statusLine(legacy)).toContain("200");
			expect(legacy.slice(legacy.indexOf("\r\n\r\n") + 4)).toBe("http://localhost/url");

			for (const authority of ["probe.test:8080", "[::1]:8080", "[2001:db8::1]"]) {
				const accepted = await rawExchange(
					base,
					`GET /url HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`,
				);
				expect(statusLine(accepted), authority).toContain("200");
				expect(accepted.slice(accepted.indexOf("\r\n\r\n") + 4)).toBe(
					`http://${authority}/url`,
				);
			}

			expect(await (await fetch(`${base}/ok`)).text()).toBe("ok");
		});
	});

	// Response.error() is status 0: serializing it verbatim emits "HTTP/1.1 0" and
	// desynchronizes the peer's response queue.
	it("answers a network-error Response with a real 5xx", async () => {
		await withServer(bin, {}, async (base) => {
			const response = await rawExchange(
				base,
				"GET /network-error HTTP/1.1\r\nHost: x\r\n\r\n" +
					"GET /ok HTTP/1.1\r\nHost: x\r\n\r\n",
			);
			expect(statusLine(response)).toMatch(/^HTTP\/1\.1 5\d\d/);
			// The queue never shifted: the follow-up request still lines up.
			expect(response.split("HTTP/1.1 ").filter((p) => p.length > 0).length).toBe(2);

			const direct = await fetch(`${base}/network-error`);
			expect(direct.status).toBe(500);
		});
	});

	// llhttp reports framing errors after the head too (a bad chunk size, a body that
	// contradicts its declared length). A bare FIN there is indistinguishable from a
	// crashed server, so the peer gets a status line as long as none was sent yet.
	it("answers a post-head framing error with 400 before closing", async () => {
		await withServer(bin, {}, async (base) => {
			const badChunk = await rawExchange(base, [
				"POST /len HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n",
				"zz\r\nHELLO\r\n",
			]);
			expect(statusLine(badChunk)).toContain("400");
			// Exactly one response: the 400 must not be followed by the handler's.
			expect(badChunk.split("HTTP/1.1 ").filter((p) => p.length > 0).length).toBe(1);

			// The same error after the application already answered can only close,
			// because a second status line would desynchronize the peer.
			const afterResponse = await rawExchange(base, [
				"GET /ok HTTP/1.1\r\nHost: x\r\n\r\n",
				"GET /ok HTTP/1.1\r\nHost: x\r\nContent-Length: 3\r\n" +
					"Transfer-Encoding: chunked\r\n\r\n",
			]);
			expect(statusLine(afterResponse)).toContain("200");
			expect(afterResponse.split("HTTP/1.1 ").filter((p) => p.length > 0).length).toBe(2);

			expect(await (await fetch(`${base}/ok`)).text()).toBe("ok");
		});
	});

	// llhttp 9.4.3 keeps reporting every header byte, so a codec limit must fail the
	// message rather than silently drop the tail: a hidden Content-Length or
	// Transfer-Encoding past the cutoff is exactly how a request smuggles framing.
	it("fails rather than truncating a head past the codec limits", async () => {
		await withServer(bin, {}, async (base) => {
			const manyFields = [
				"GET /ok HTTP/1.1\r\nHost: x\r\n",
				...Array.from({ length: 300 }, (_, i) => `X-Pad-${i}: v\r\n`),
				"Transfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
			].join("");
			expect(statusLine(await rawExchange(base, manyFields))).toContain("400");

			const hugeValue =
				`GET /ok HTTP/1.1\r\nHost: x\r\nX-Pad: ${"v".repeat(32 * 1024)}\r\n` +
				"Content-Length: 0\r\n\r\n";
			expect(statusLine(await rawExchange(base, hugeValue))).toContain("400");

			const hugeHead = [
				"GET /ok HTTP/1.1\r\nHost: x\r\n",
				...Array.from({ length: 200 }, (_, i) => `X-Pad-${i}: ${"v".repeat(512)}\r\n`),
				"Content-Length: 0\r\n\r\n",
			].join("");
			expect(statusLine(await rawExchange(base, hugeHead))).toContain("400");

			expect(await (await fetch(`${base}/ok`)).text()).toBe("ok");
		});
	});

	it("accepts realistic request heads that spill inline codec storage", async () => {
		await withServer(bin, {}, async (base) => {
			const headers = Array.from(
				{ length: 24 },
				(_, index) => `X-Browser-${index}: ${"v".repeat(64)}\r\n`,
			).join("");
			const response = await rawExchange(
				base,
				`GET /ok HTTP/1.1\r\nHost: x\r\n${headers}\r\n`,
			);
			expect(statusLine(response)).toContain("200");
			expect(response).toContain("ok");
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
