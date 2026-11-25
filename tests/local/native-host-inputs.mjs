import { Buffer } from "node:buffer";
import { readdir } from "node:fs/promises";
import { isAbsolute } from "node:path/posix";
import { types } from "node:util";

function read(value) {
	if (!types.isUint8Array(value)) return "other";
	return value[0];
}

function length(value) {
	try {
		isAbsolute(value);
		return value.length;
	} catch {
		return -value.length;
	}
}

function borrowAndWrite(value) {
	const state = { value };
	const bytes = Buffer.alloc(3);
	const same = bytes.fill(42);
	types.isUint8Array(state);
	const encoded = new TextEncoder(state).encodeInto(state.value, bytes);
	return [same === bytes, encoded.read, encoded.written, ...bytes];
}

function tagLengths(query) {
	const tags = new URLSearchParams(query).getAll("tag");
	let total = 0;
	for (let i = 0; i < tags.length; i++) total += tags[i].length;
	return total;
}

function consumeChangedTags(query, change) {
	const tags = new URLSearchParams(query).getAll("tag");
	change(tags);
	let total = 0;
	for (let i = 0; i < tags.length; i++) total += tags[i].length;
	return total;
}

async function countEntryNames(path) {
	const entries = await readdir(path, { withFileTypes: true }).then((values) => values);
	let total = 0;
	for (let i = 0; i < entries.length; i++) total += entries[i].name.length;
	return total;
}

function matchSubjectLength(value) {
	try {
		return /example/.exec(value).input.length;
	} catch (error) {
		return error.name;
	}
}

function Match(text, steps) {
	for (let i = 0; i < steps; i++) globalThis.visited = i;
	this.input = 42;
	return /example/.exec(text);
}

function matchConstructorInput(text, steps) {
	return typeof new Match(text, steps).input;
}

globalThis.hostRead = read;
globalThis.hostLength = length;
console.log(
	JSON.stringify([
		read(new Uint8Array([231])),
		read(new Uint8Array()),
		read({ 0: 12 }),
		length("/example"),
		length({ length: 9 }),
		borrowAndWrite("é"),
		tagLengths("tag=one&tag=three&ignored=unused"),
		tagLengths(""),
		consumeChangedTags("tag=abc", (tags) => {
			tags[0] = { length: 37 };
		}),
		await countEntryNames("tests/fixtures"),
		matchSubjectLength({ toString: () => "an example" }),
		matchSubjectLength("unmatched"),
		matchConstructorInput("an example", 2),
		matchConstructorInput("unmatched", 1),
		[""[Symbol.iterator]().next().done, "é"[Symbol.iterator]().next().value],
	]),
);
