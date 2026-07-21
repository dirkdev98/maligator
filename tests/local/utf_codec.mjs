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

const withNul = "A\0B";
const nulBytes = encoder.encode(withNul);
check(
	"length-based codecs preserve embedded NUL",
	nulBytes.length === 3 && nulBytes[1] === 0 && decoder.decode(nulBytes) === withNul,
);
let rejectedNul = false;
try {
	existsSync(`/tmp/maligator-utf-prefix\0suffix`);
} catch (error) {
	rejectedNul = error instanceof TypeError;
}
check("C-string boundary rejects embedded NUL", rejectedNul);

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
