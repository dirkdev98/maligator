/* oxlint-disable typescript/no-unsafe-argument, typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return -- This source is compiled inside Maligator, whose Node host objects intentionally have no TypeScript declarations. */

/** Node-surface compatibility globals implemented over Maligator's node:* host modules. */

import { request as nodeRequest } from "node:http";
import { request as nodeSecureRequest } from "node:https";

class MaligatorHeaders {
	constructor(init = undefined) {
		/** @type {Map<string, string>} */
		this._entries = new Map();
		if (init === undefined || init === null) return;
		if (init instanceof MaligatorHeaders) {
			for (const [name, value] of init) this.append(name, value);
			return;
		}
		if (Array.isArray(init)) {
			for (const pair of init) {
				if (!Array.isArray(pair) || pair.length !== 2) {
					throw new TypeError("Headers entry must contain exactly two items");
				}
				this.append(pair[0], pair[1]);
			}
			return;
		}
		if (typeof init[Symbol.iterator] === "function") {
			for (const pair of init) {
				if (!Array.isArray(pair) || pair.length !== 2) {
					throw new TypeError("Headers entry must contain exactly two items");
				}
				this.append(pair[0], pair[1]);
			}
			return;
		}
		for (const name of Object.keys(init)) this.append(name, init[name]);
	}

	_name(value) {
		const name = String(value).toLowerCase();
		const punctuation = "!#$%&'*+-.^_`|~";
		if (name.length === 0) throw new TypeError("Invalid header name");
		for (const char of name) {
			const code = char.charCodeAt(0);
			if (
				!(code >= 48 && code <= 57) &&
				!(code >= 97 && code <= 122) &&
				!punctuation.includes(char)
			) {
				throw new TypeError("Invalid header name");
			}
		}
		return name;
	}

	_value(value) {
		const normalized = String(value).trim();
		if (
			normalized.includes("\r") ||
			normalized.includes("\n") ||
			normalized.includes("\0")
		) {
			throw new TypeError("Invalid header value");
		}
		return normalized;
	}

	append(name, value) {
		const normalizedName = this._name(name);
		const normalizedValue = this._value(value);
		const current = this._entries.get(normalizedName);
		this._entries.set(
			normalizedName,
			current === undefined ? normalizedValue : `${current}, ${normalizedValue}`,
		);
	}

	delete(name) {
		this._entries.delete(this._name(name));
	}

	get(name) {
		return this._entries.get(this._name(name)) ?? null;
	}

	has(name) {
		return this._entries.has(this._name(name));
	}

	set(name, value) {
		this._entries.set(this._name(name), this._value(value));
	}

	*entries() {
		yield* [...this._entries.entries()].sort(([left], [right]) =>
			left < right ? -1 : left > right ? 1 : 0,
		);
	}

	/**
	 * @param {(value: string, name: string, headers: MaligatorHeaders) => void} callback
	 * @param {unknown} thisArg
	 */
	forEach(callback, thisArg = undefined) {
		for (const [name, value] of this) callback.call(thisArg, value, name, this);
	}

	*keys() {
		for (const [name] of this.entries()) yield name;
	}

	*values() {
		for (const [, value] of this.entries()) yield value;
	}

	[Symbol.iterator]() {
		return this.entries();
	}
}

if (typeof globalThis.Headers !== "function") globalThis.Headers = MaligatorHeaders;

class MaligatorResponse {
	constructor(body, init = {}) {
		this.status = init.status ?? 200;
		this.statusText = init.statusText ?? "";
		this.headers = new MaligatorHeaders(init.headers);
		this.url = init.url ?? "";
		this.redirected = init.redirected ?? false;
		this.type = "basic";
		this._used = false;
		if (body === null || body === undefined) this.body = null;
		else if (typeof body.getReader === "function") this.body = body;
		else {
			const bytes = typeof body === "string" ? Buffer.from(body) : body;
			this.body = new ReadableStream({
				start(controller) {
					controller.enqueue(bytes);
					controller.close();
				},
			});
		}
		this._native =
			typeof globalThis.Response === "function" &&
			globalThis.Response !== MaligatorResponse
				? new globalThis.Response(this.body, { headers: this.headers })
				: undefined;
	}

	get bodyUsed() {
		return this._native?.bodyUsed ?? this._used;
	}

	get ok() {
		return this.status >= 200 && this.status <= 299;
	}

	async bytes() {
		if (this._native) return await this._native.bytes();
		if (this.bodyUsed || this.body?.locked)
			throw new TypeError("Body has already been consumed");
		this._used = true;
		if (this.body === null) return new Uint8Array(0);
		const reader = this.body.getReader();
		const chunks = [];
		let length = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				chunks.push(value);
				length += value.byteLength;
			}
		} finally {
			reader.releaseLock();
		}
		return Buffer.concat(chunks, length);
	}

	async text() {
		if (this._native) return await this._native.text();
		return (await this.bytes()).toString("utf8");
	}
	async json() {
		return JSON.parse(await this.text());
	}
	async arrayBuffer() {
		const bytes = await this.bytes();
		return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	}
	async blob() {
		if (this._native) return await this._native.blob();
		return new Blob([await this.bytes()], {
			type: this.headers.get("content-type") ?? "",
		});
	}
}

async function maligatorFetch(input, init = {}) {
	const inherited = input instanceof Request ? input : undefined;
	const url = new URL(typeof input === "object" && input.url ? input.url : String(input));
	if (url.username || url.password)
		return Promise.reject(new TypeError("Fetch URL contains credentials"));
	const headers = new MaligatorHeaders(init.headers ?? inherited?.headers);
	const method = String(init.method ?? inherited?.method ?? "GET").toUpperCase();
	let body = init.body ?? inherited?.body;
	if ((method === "GET" || method === "HEAD") && body !== undefined && body !== null) {
		return Promise.reject(new TypeError("GET and HEAD requests cannot have a body"));
	}
	const signal = init.signal ?? inherited?.signal;
	// oxlint-disable-next-line typescript/prefer-promise-reject-errors -- AbortSignal.reason may be any JavaScript value.
	if (signal?.aborted) return Promise.reject(signal.reason);
	const redirect = init.redirect ?? inherited?.redirect ?? "follow";
	if (!["follow", "error", "manual"].includes(redirect)) {
		return Promise.reject(new TypeError("Invalid redirect mode"));
	}
	if (inherited?.bodyUsed && (init.body === undefined || init.body === null))
		throw new TypeError("Request body has already been consumed");
	const streaming =
		body !== undefined &&
		body !== null &&
		(typeof body.getReader === "function" ||
			typeof body[Symbol.asyncIterator] === "function");
	const duplex = init.duplex ?? inherited?.duplex;
	if ((duplex !== undefined && duplex !== "half") || (streaming && duplex !== "half"))
		throw new TypeError("Streaming request bodies require duplex: half");
	if (body !== undefined && body !== null && !streaming) {
		const normalized = new Response(body);
		if (!headers.has("content-type") && normalized.headers.has("content-type"))
			headers.set("content-type", normalized.headers.get("content-type"));
		body = await normalized.bytes();
	}
	return fetchRequest(url, method, headers, body, signal, redirect, 0, streaming);
}

function waitForDrain(request, signal) {
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			request.off("drain", drain);
			request.off("error", error);
			request.off("close", close);
			signal?.removeEventListener("abort", abort);
		};
		const drain = () => {
			cleanup();
			resolve();
		};
		const error = (reason) => {
			cleanup();
			// oxlint-disable-next-line typescript/prefer-promise-reject-errors -- AbortSignal.reason may be any JavaScript value.
			reject(reason);
		};
		const close = () => error(new TypeError("Request closed during upload"));
		const abort = () => error(signal.reason);
		request.once("drain", drain);
		request.once("error", error);
		request.once("close", close);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		else if (request.destroyed) close();
	});
}

function fetchRequest(
	url,
	method,
	headers,
	body,
	signal,
	redirect,
	redirects,
	streaming,
) {
	return new Promise((resolve, reject) => {
		let request;
		let response;
		let controller;
		let finished = false;
		let uploadDone = !streaming;
		let uploadReader;
		let uploadIterator;
		const cleanup = () => signal?.removeEventListener("abort", abort);
		const stopUpload = (reason) => {
			if (uploadDone) return;
			uploadDone = true;
			try {
				const cancelled = uploadReader
					? uploadReader.cancel(reason)
					: uploadIterator?.return?.();
				Promise.resolve(cancelled).catch(() => {});
			} catch {
				// Cancellation failure must not replace the transport or abort reason.
			}
			request?.destroy();
		};
		const fail = (error) => {
			if (finished) return;
			finished = true;
			cleanup();
			stopUpload(error);
			response?.destroy();
			request?.destroy();
			if (controller) controller.error(error);
			// oxlint-disable-next-line typescript/prefer-promise-reject-errors -- AbortSignal.reason may be any JavaScript value.
			reject(error);
		};
		const abort = () => {
			const reason = signal.reason;
			fail(reason);
		};
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) {
			abort();
			return;
		}
		if (url.protocol === "data:") {
			try {
				const comma = url.href.indexOf(",");
				if (comma < 0) throw new TypeError("Invalid data URL");
				const meta = url.href.slice(5, comma);
				const data = decodeURIComponent(url.href.slice(comma + 1));
				const base64 = meta.endsWith(";base64");
				const bytes = Buffer.from(data, base64 ? "base64" : "utf8");
				finished = true;
				cleanup();
				resolve(
					new MaligatorResponse(bytes, {
						url: url.href,
						headers: {
							"content-type":
								(base64 ? meta.slice(0, -7) : meta) || "text/plain;charset=US-ASCII",
						},
					}),
				);
			} catch (error) {
				fail(error);
			}
			return;
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			fail(new TypeError("Unsupported fetch URL scheme"));
			return;
		}
		try {
			const requestHeaders = Object.create(null);
			for (const [name, value] of headers) requestHeaders[name] = value;
			const send = url.protocol === "https:" ? nodeSecureRequest : nodeRequest;
			request = send(url.href, { method, headers: requestHeaders }, (incoming) => {
				response = incoming;
				response.on("error", fail);
				const status = response.statusCode ?? 0;
				const location = response.headers.location;
				if (
					[301, 302, 303, 307, 308].includes(status) &&
					location &&
					redirect !== "manual"
				) {
					if (redirect === "error" || redirects >= 20) {
						fail(
							new TypeError(
								redirect === "error" ? "Unexpected redirect" : "Too many redirects",
							),
						);
						response.destroy();
						return;
					}
					try {
						// Fetch cannot replay a source-less stream after a redirect except 303.
						if (streaming && status !== 303)
							throw new TypeError(
								"Cannot replay a streaming request body after a redirect",
							);
						const next = new URL(location, url);
						if (next.username || next.password)
							throw new TypeError("Redirect URL contains credentials");
						const nextHeaders = new MaligatorHeaders(headers);
						if (next.origin !== url.origin) {
							for (const name of ["authorization", "proxy-authorization", "cookie"])
								nextHeaders.delete(name);
						}
						const rewrite =
							(status === 303 && method !== "HEAD") ||
							((status === 301 || status === 302) && method === "POST");
						if (rewrite)
							for (const name of [
								"content-length",
								"content-type",
								"content-encoding",
								"content-language",
								"content-location",
							])
								nextHeaders.delete(name);
						finished = true;
						cleanup();
						stopUpload();
						response.destroy();
						resolve(
							fetchRequest(
								next,
								rewrite ? "GET" : method,
								nextHeaders,
								rewrite ? undefined : body,
								signal,
								redirect,
								redirects + 1,
								streaming && !rewrite,
							),
						);
					} catch (error) {
						fail(error);
						response.destroy();
					}
					return;
				}
				const empty = method === "HEAD" || [204, 205, 304].includes(status);
				let stream = null;
				if (!empty) {
					response.pause();
					stream = new ReadableStream(
						{
							start(value) {
								controller = value;
							},
							pull() {
								response.resume();
							},
							cancel(reason) {
								finished = true;
								cleanup();
								stopUpload(reason);
								response.destroy();
								request.destroy();
							},
						},
						{ highWaterMark: 65536, size: (chunk) => chunk.byteLength },
					);
					response.on("data", (chunk) => {
						if (finished) return;
						controller.enqueue(chunk);
						if (controller.desiredSize <= 0) response.pause();
					});
				}
				response.on("end", () => {
					if (finished) return;
					finished = true;
					cleanup();
					stopUpload();
					controller?.close();
				});
				response.on("close", () => {
					if (!finished) fail(new TypeError("Response body closed prematurely"));
				});
				if (empty) response.resume();
				resolve(
					new MaligatorResponse(stream, {
						status,
						statusText: response.statusMessage ?? "",
						headers: response.headers,
						url: url.href,
						redirected: redirects > 0,
					}),
				);
			});
			request.on("error", fail);
			if (!streaming) request.end(body);
			else {
				const upload = async () => {
					try {
						if (typeof body.getReader === "function") uploadReader = body.getReader();
						else uploadIterator = body[Symbol.asyncIterator]();
						while (!uploadDone && !finished) {
							const { done, value } = await (uploadReader
								? uploadReader.read()
								: uploadIterator.next());
							if (uploadDone || finished) return;
							if (done) break;
							if (!(value instanceof Uint8Array) && typeof value !== "string")
								throw new TypeError(
									"Request body chunks must be strings or Uint8Array values",
								);
							if (!request.write(value)) await waitForDrain(request, signal);
						}
						if (!uploadDone && !finished) {
							uploadDone = true;
							request.end();
						}
					} catch (error) {
						fail(error);
					} finally {
						uploadReader?.releaseLock();
					}
				};
				upload().catch(fail);
			}
		} catch (error) {
			fail(error);
			request?.destroy();
		}
	});
}

if (typeof globalThis.Response !== "function") globalThis.Response = MaligatorResponse;
if (typeof globalThis.fetch !== "function") globalThis.fetch = maligatorFetch;

export { MaligatorHeaders, MaligatorResponse, maligatorFetch };
