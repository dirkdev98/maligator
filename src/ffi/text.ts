import type { Buffer } from "node:buffer";

const CHUNK_SIZE = 256 * 1024;

/** Header prose stays bounded internally; JSON and declarations emit its fragments. */
export class FfiText {
	readonly chunks: ReadonlyArray<string>;
	readonly length: number;

	constructor(input: Iterable<string>) {
		const chunks: Array<string> = [];
		let parts: Array<string> = [];
		let units = 0;
		const flush = (final: boolean): void => {
			let text = parts.length === 1 ? parts[0]! : parts.join("");
			parts = [];
			units = 0;
			const last = text.charCodeAt(text.length - 1);
			if (!final && last >= 0xd800 && last <= 0xdbff) {
				parts.push(text.slice(-1));
				units = 1;
				text = text.slice(0, -1);
			}
			if (text.length > 0) chunks.push(text);
		};
		for (const part of input) {
			for (let start = 0; start < part.length;) {
				const end = Math.min(part.length, start + CHUNK_SIZE - units);
				parts.push(part.slice(start, end));
				units += end - start;
				start = end;
				if (units === CHUNK_SIZE) flush(false);
			}
		}
		flush(true);
		this.chunks = chunks;
		this.length = chunks.reduce((total, chunk) => total + chunk.length, 0);
	}

	static fromUtf8(data: Buffer, start = 0, end = data.length): FfiText {
		const parts: Array<string> = [];
		while (start < end) {
			let next = Math.min(end, start + CHUNK_SIZE);
			if (next < end) while (next > start && (data[next]! & 0xc0) === 0x80) next--;
			if (next === start) next = Math.min(end, start + CHUNK_SIZE);
			parts.push(data.toString("utf8", start, next));
			start = next;
		}
		return new FfiText(parts);
	}

	slice(start = 0, end = this.length): FfiText {
		start = Math.min(this.length, Math.max(0, start < 0 ? this.length + start : start));
		end = Math.min(this.length, Math.max(start, end < 0 ? this.length + end : end));
		const parts: Array<string> = [];
		let offset = 0;
		for (const chunk of this.chunks) {
			if (offset >= end) break;
			if (offset + chunk.length > start)
				parts.push(chunk.slice(Math.max(0, start - offset), end - offset));
			offset += chunk.length;
		}
		return new FfiText(parts);
	}

	trimStart(): FfiText {
		let start = 0;
		for (const chunk of this.chunks) {
			const trimmed = chunk.trimStart();
			start += chunk.length - trimmed.length;
			if (trimmed.length > 0) break;
		}
		return this.slice(start);
	}

	trimEnd(): FfiText {
		let end = this.length;
		for (let index = this.chunks.length - 1; index >= 0; index--) {
			const chunk = this.chunks[index]!;
			const trimmed = chunk.trimEnd();
			end -= chunk.length - trimmed.length;
			if (trimmed.length > 0) break;
		}
		return this.slice(0, end);
	}

	trim(): FfiText {
		return this.trimStart().trimEnd();
	}

	startsWith(prefix: string): boolean {
		return this.slice(0, prefix.length).chunks.join("") === prefix;
	}

	endsWith(suffix: string): boolean {
		return (
			this.slice(Math.max(0, this.length - suffix.length)).chunks.join("") === suffix
		);
	}

	indexOf(needle: string): number {
		if (needle === "") return 0;
		let carry = "";
		let offset = 0;
		for (const chunk of this.chunks) {
			const text = carry + chunk;
			const found = text.indexOf(needle);
			if (found >= 0) return offset - carry.length + found;
			carry = text.slice(Math.max(0, text.length - needle.length + 1));
			offset += chunk.length;
		}
		return -1;
	}

	includes(needle: string): boolean {
		return this.indexOf(needle) >= 0;
	}

	*lines(): Generator<FfiText> {
		let parts: Array<string> = [];
		for (const chunk of this.chunks) {
			let start = 0;
			for (;;) {
				const end = chunk.indexOf("\n", start);
				if (end < 0) break;
				parts.push(chunk.slice(start, end));
				yield new FfiText(parts);
				parts = [];
				start = end + 1;
			}
			parts.push(chunk.slice(start));
		}
		yield new FfiText(parts);
	}
}

export function joinText(parts: ReadonlyArray<FfiText>, separator: string): FfiText {
	return new FfiText(
		parts.flatMap((text, index) => [...(index === 0 ? [] : [separator]), ...text.chunks]),
	);
}

/** Searches the short ownership keywords used by contract suggestions across fragments. */
export function textMatches(text: FfiText | undefined, expression: RegExp): boolean {
	const search = new RegExp(
		expression.source,
		`${expression.flags.replaceAll("g", "")}g`,
	);
	let carry = "";
	const chunks = text?.chunks ?? [];
	for (let index = 0; index < chunks.length; index++) {
		const chunk = chunks[index]!;
		const value = carry + chunk + (chunks[index + 1]?.slice(0, 1) ?? "");
		search.lastIndex = 0;
		for (;;) {
			const match = search.exec(value);
			if (match === null) break;
			if (
				(index === 0 || match.index > 0) &&
				match.index + match[0].length <= carry.length + chunk.length
			)
				return true;
			if (match[0].length === 0) search.lastIndex++;
		}
		carry = (carry + chunk).slice(-128);
	}
	return false;
}
