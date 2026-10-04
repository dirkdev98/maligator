import { existsSync } from "node:fs";

const results = [];
function check(name, condition) {
	results.push([name, !!condition]);
}
function bytes(value) {
	return Array.from(value).join(",");
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

check("empty encode", encoder.encode("").length === 0);
check("empty decode", decoder.decode(new Uint8Array(0)) === "");
check(
	"lone surrogates use replacement",
	bytes(encoder.encode("\ud800\udc00\ud800X\udc00")) ===
		"240,144,128,128,239,191,189,88,239,191,189",
);
check(
	"malformed UTF-8 replacement boundaries",
	decoder.decode(new Uint8Array([0xe1, 0x80, 0x41])) === "\ufffdA" &&
		decoder.decode(new Uint8Array([0xed, 0xa0, 0x80])) === "\ufffd\ufffd\ufffd" &&
		decoder.decode(new Uint8Array([0xf0, 0x9f])) === "\ufffd",
);

function concatBytes(parts) {
	const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.length;
	}
	return output;
}
const mixedSegments = [
	[encoder.encode("\u6771\u4eac\u0100\u20ac"), "\u6771\u4eac\u0100\u20ac"],
	[[0xe1, 0x80, 0x41], "\ufffdA"],
	[[0xed, 0xa0, 0x80], "\ufffd\ufffd\ufffd"],
	[[0xe0, 0x80], "\ufffd\ufffd"],
	[[0xc0, 0xaf], "\ufffd\ufffd"],
	[[0xf0, 0x9f, 0x98, 0x80], "\ud83d\ude00"],
	[[0xf0, 0x9f, 0x41], "\ufffdA"],
	[[0xf4, 0x90, 0x80, 0x80], "\ufffd\ufffd\ufffd\ufffd"],
	[[0xc3, 0xa9], "\u00e9"],
];
let shiftedRunsMatch = true;
for (let shift = 0; shift < 48; shift++) {
	const parts = [
		encoder.encode(shift % 2 === 0 ? "\u00e9" : "\u6771"),
		encoder.encode("a".repeat(shift)),
	];
	let expected = (shift % 2 === 0 ? "\u00e9" : "\u6771") + "a".repeat(shift);
	for (let round = 0; round < 8; round++) {
		for (const [segment, text] of mixedSegments.slice(round % 2 === 0 ? 1 : 0)) {
			parts.push(Uint8Array.from(segment), encoder.encode("b".repeat(round)));
			expected += text + "b".repeat(round);
		}
	}
	if (decoder.decode(concatBytes(parts)) !== expected) shiftedRunsMatch = false;
}
check(
	"decoding resumes across growth inside multi-byte and malformed runs",
	shiftedRunsMatch,
);

let latin1Expected = "\u00e9";
for (let shift = 0; shift < 40; shift++)
	latin1Expected += "x".repeat(shift) + "\u00ff\u00c0";
check(
	"Latin-1 runs survive growth",
	decoder.decode(encoder.encode(latin1Expected)) === latin1Expected,
);

const withNul = "A\0B";
const nulBytes = encoder.encode(withNul);
check(
	"length-based codecs preserve embedded NUL",
	nulBytes.length === 3 && nulBytes[1] === 0 && decoder.decode(nulBytes) === withNul,
);
check(
	"C-string boundary rejects rather than truncates embedded NUL",
	existsSync(`/tmp/maligator-utf-prefix\0suffix`) === false,
);

const large = "x".repeat(65536) + "\ud83d\ude00\ud800";
const encodedLarge = encoder.encode(large);
check(
	"large allocation length",
	encodedLarge.length === 65536 + 4 + 3 &&
		decoder.decode(encodedLarge).length === 65536 + 2 + 1,
);

let passed = 0;
for (const [name, condition] of results) {
	if (condition) passed++;
	else console.log(`FAIL: ${name}`);
}
console.log(`RESULT ${passed}/${results.length}`);
