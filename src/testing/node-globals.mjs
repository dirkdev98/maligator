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

export { MaligatorHeaders };
