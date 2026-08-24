import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

const results = [];
function check(name, condition) {
	results.push([name, !!condition]);
}

const whitespace = [
	0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680, 0x2000, 0x2001, 0x2002,
	0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f,
	0x205f, 0x3000, 0xfeff,
];

function regexpWhitespaceEscape(codePoint) {
	if (codePoint === 0x09) return "\\t";
	if (codePoint === 0x0a) return "\\n";
	if (codePoint === 0x0b) return "\\v";
	if (codePoint === 0x0c) return "\\f";
	if (codePoint === 0x0d) return "\\r";
	const hex = codePoint.toString(16).padStart(codePoint <= 0xff ? 2 : 4, "0");
	return (codePoint <= 0xff ? "\\x" : "\\u") + hex;
}

for (const codePoint of whitespace) {
	const unit = String.fromCharCode(codePoint);
	const label = "U+" + codePoint.toString(16).padStart(4, "0");
	check(
		"ECMAScript whitespace " + label,
		(unit + "value" + unit).trim() === "value" &&
			parseInt(unit + "42", 10) === 42 &&
			parseFloat(unit + "1.5tail") === 1.5 &&
			BigInt(unit + "42" + unit) === 42n &&
			Number(unit + "42" + unit) === 42 &&
			RegExp.escape(unit) === regexpWhitespaceEscape(codePoint),
	);
}

const nonWhitespace = [
	0x0008, 0x000e, 0x0085, 0x167f, 0x180e, 0x200b, 0x202a, 0x2060, 0x3001, 0xfffe,
];
for (const codePoint of nonWhitespace) {
	const unit = String.fromCharCode(codePoint);
	const label = "U+" + codePoint.toString(16).padStart(4, "0");
	check(
		"non-whitespace neighbor " + label,
		(unit + "value" + unit).trim() === unit + "value" + unit &&
			Number.isNaN(parseInt(unit + "42", 10)) &&
			Number.isNaN(parseFloat(unit + "1.5")) &&
			Number.isNaN(Number(unit + "42")) &&
			RegExp.escape(unit) === unit,
	);
}

const pair = "\ud83d\ude00";
const malformed = "\ud800A\udc00" + pair;
check(
	"code point composition and iteration preserve policy",
	pair.codePointAt(0) === 0x1f600 &&
		malformed.codePointAt(0) === 0xd800 &&
		String.fromCodePoint(0x1f600, 0xd800) === pair + "\ud800" &&
		Array.from(malformed).join("|") === "\ud800|A|\udc00|" + pair &&
		Array.from(malformed.matchAll(/./gu)).length === 4,
);
check(
	"well-formed and JSON lone-surrogate policies",
	!malformed.isWellFormed() &&
		pair.isWellFormed() &&
		malformed.toWellFormed() === "\ufffdA\ufffd" + pair &&
		JSON.stringify(malformed) === '"\\ud800A\\udc00' + pair + '"',
);
const boundaryPair = "abc\ud83d\ude00x";
const boundaryLone = "abc\ud800x";
check(
	"well-formed scans preserve block-boundary surrogate pairs",
	boundaryPair.isWellFormed() &&
		!boundaryLone.isWellFormed() &&
		boundaryLone.toWellFormed() === "abc\ufffdx",
);

let uriLeadThrew = false;
let uriTrailThrew = false;
try {
	encodeURIComponent("\ud800");
} catch (error) {
	uriLeadThrew = error instanceof URIError;
}
try {
	encodeURIComponent("\udc00");
} catch (error) {
	uriTrailThrew = error instanceof URIError;
}
check(
	"URI scalar rejection policy",
	uriLeadThrew && uriTrailThrew && encodeURIComponent(pair) === "%F0%9F%98%80",
);

const params = new URLSearchParams();
params.append("value", malformed);
check("Web IDL USV replacement policy", params.get("value") === "\ufffdA\ufffd" + pair);

const encoder = new TextEncoder();
check(
	"UTF-8 replacement policy",
	Array.from(encoder.encode(malformed)).join(",") ===
		"239,191,189,65,239,191,189,240,159,152,128",
);

const encodeSource = "A" + pair + "\ud800B";
const boundaries = [
	[0, 0, 0],
	[1, 1, 1],
	[4, 1, 1],
	[5, 3, 5],
	[7, 3, 5],
	[8, 4, 8],
	[9, 5, 9],
];
for (const [capacity, expectedRead, expectedWritten] of boundaries) {
	const destination = new Uint8Array(capacity);
	const result = encoder.encodeInto(encodeSource, destination);
	check(
		"encodeInto boundary " + capacity,
		result.read === expectedRead && result.written === expectedWritten,
	);
}

check(
	"ASCII-CI encoding labels retain grammar-specific trim policy",
	new TextDecoder(" \tUtF-8\n").encoding === "utf-8" &&
		Buffer.from("A", "UtF8").toString("UTF-8") === "A" &&
		new StringDecoder("UtF-16LE").encoding === "utf16le" &&
		createHash("sha1").update("abc", "UtF-8").digest("base64") ===
			"qZk+NkcGgWq6PiVxeFDCbJzQ2J0=" &&
		!Number.isNaN(Date.parse("JAN 02 2020 GMT")) &&
		new Request("https://example.com", { method: "gEt" }).method === "GET",
);

let passed = 0;
for (const [name, condition] of results) {
	if (condition) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
