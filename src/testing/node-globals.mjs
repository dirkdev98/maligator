/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- This source is compiled inside Maligator, whose Node host objects intentionally have no TypeScript declarations. */

import { request as nodeRequest } from "node:http";

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
		this._body = body;
		this.status = init.status ?? 200;
		this.statusText = init.statusText ?? "";
		this.headers = new MaligatorHeaders(init.headers);
		this.url = init.url ?? "";
		this.redirected = false;
		this.type = "basic";
	}

	get ok() {
		return this.status >= 200 && this.status <= 299;
	}

	async text() {
		return this._body.toString("utf8");
	}

	async json() {
		return JSON.parse(await this.text());
	}

	async arrayBuffer() {
		const copy = new Uint8Array(this._body.length);
		copy.set(this._body);
		return copy.buffer;
	}

	async bytes() {
		const copy = new Uint8Array(this._body.length);
		copy.set(this._body);
		return copy;
	}
}

function maligatorFetch(input, init = {}) {
	return new Promise((resolve, reject) => {
		const headers = new MaligatorHeaders(init.headers);
		const requestHeaders = Object.create(null);
		for (const [name, value] of headers) requestHeaders[name] = value;
		const url = String(input);
		const request = nodeRequest(
			url,
			{
				method: init.method ?? "GET",
				headers: requestHeaders,
			},
			(response) => {
				const chunks = [];
				response.on("data", (chunk) => chunks.push(chunk));
				response.on("error", reject);
				response.on("end", () => {
					resolve(
						new MaligatorResponse(Buffer.concat(chunks), {
							status: response.statusCode ?? 0,
							statusText: response.statusMessage ?? "",
							headers: response.headers,
							url,
						}),
					);
				});
			},
		);
		request.on("error", reject);
		if (init.body !== undefined && init.body !== null) request.write(init.body);
		request.end();
	});
}

if (typeof globalThis.Response !== "function") globalThis.Response = MaligatorResponse;
if (typeof globalThis.fetch !== "function") globalThis.fetch = maligatorFetch;

export { MaligatorHeaders, MaligatorResponse, maligatorFetch };
