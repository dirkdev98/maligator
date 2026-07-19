const results = [];

function check(name, condition) {
	results.push([name, !!condition]);
}

function throwsTypeError(fn) {
	try {
		fn();
	} catch (error) {
		return error instanceof TypeError;
	}
	return false;
}

function bytes(values) {
	return new Uint8Array(values);
}

const utf8 = new TextDecoder();
check("utf8 split two-byte start", utf8.decode(bytes([0xc2]), { stream: true }) === "");
check("utf8 split two-byte end", utf8.decode(bytes([0xa2]), { stream: true }) === "¢");
check(
	"utf8 split four-byte start",
	utf8.decode(bytes([0xf0, 0x9f, 0x92]), { stream: true }) === "",
);
check("utf8 split four-byte end", utf8.decode(bytes([0xa9]), { stream: true }) === "💩");
check("utf8 empty final flush", utf8.decode() === "");

const malformed = new TextDecoder();
check(
	"utf8 malformed continuation restores ASCII",
	malformed.decode(bytes([0xe0, 0x41]), { stream: true }) === "�A",
);
check(
	"utf8 malformed range is immediate",
	malformed.decode(bytes([0xf0, 0x80]), { stream: true }) === "��",
);
check(
	"utf8 malformed tail flushes",
	malformed.decode(bytes([0xf0]), { stream: true }) === "",
);
check("utf8 incomplete replacement on flush", malformed.decode() === "�");

for (const [label, bom, a, pair] of [
	["utf-8", [0xef, 0xbb, 0xbf], [0x61], [0xf0, 0x9f, 0x98, 0x80]],
	["utf-16le", [0xff, 0xfe], [0x61, 0x00], [0x3d, 0xd8, 0x00, 0xde]],
	["utf-16be", [0xfe, 0xff], [0x00, 0x61], [0xd8, 0x3d, 0xde, 0x00]],
]) {
	const decoder = new TextDecoder(label);
	let output = "";
	for (const value of bom) output += decoder.decode(bytes([value]), { stream: true });
	check(label + " split BOM waits and strips", output === "");
	check(
		label + " content after split BOM",
		decoder.decode(bytes(a), { stream: true }) === "a",
	);
	check(
		label + " later BOM is data",
		decoder.decode(bytes(bom), { stream: true }) === "﻿",
	);
	check(label + " stream finishes", decoder.decode() === "");

	const splitPair = new TextDecoder(label);
	output = "";
	for (const value of pair) output += splitPair.decode(bytes([value]), { stream: true });
	output += splitPair.decode();
	check(label + " scalar survives byte-sized chunks", output === "😀");
}

const ignoredBom = new TextDecoder("utf-8", { ignoreBOM: true });
check(
	"empty stream does not consume BOM state",
	ignoredBom.decode(bytes([]), { stream: true }) === "",
);
check(
	"ignoreBOM split start waits",
	ignoredBom.decode(bytes([0xef]), { stream: true }) === "",
);
check("ignoreBOM preserves split BOM", ignoredBom.decode(bytes([0xbb, 0xbf])) === "﻿");

const oddLe = new TextDecoder("utf-16le");
check("utf16 odd byte waits", oddLe.decode(bytes([0x61]), { stream: true }) === "");
check("utf16 odd byte combines", oddLe.decode(bytes([0x00]), { stream: true }) === "a");
check(
	"utf16 high surrogate waits",
	oddLe.decode(bytes([0x3d, 0xd8]), { stream: true }) === "",
);
check("utf16 surrogate pair combines", oddLe.decode(bytes([0x00, 0xde])) === "😀");

const flushReset = new TextDecoder();
check("flush setup", flushReset.decode(bytes([0xe2]), { stream: true }) === "");
check("flush emits replacement", flushReset.decode() === "�");
check(
	"reset strips a fresh BOM",
	flushReset.decode(bytes([0xef, 0xbb, 0xbf, 0x61])) === "a",
);
check(
	"reuse starts independent decode",
	flushReset.decode(bytes([0xe2, 0x82, 0xac])) === "€",
);

const fatal8 = new TextDecoder("utf-8", { fatal: true });
check("fatal utf8 partial waits", fatal8.decode(bytes([0xe2]), { stream: true }) === "");
check(
	"fatal utf8 malformed continuation throws",
	throwsTypeError(() => fatal8.decode(bytes([0x41]))),
);
check("fatal utf8 resets after final error", fatal8.decode(bytes([0x61])) === "a");
check(
	"fatal utf8 partial waits again",
	fatal8.decode(bytes([0xf0]), { stream: true }) === "",
);
check(
	"fatal utf8 flush throws",
	throwsTypeError(() => fatal8.decode()),
);
check("fatal utf8 reusable after flush error", fatal8.decode(bytes([0x62])) === "b");

const fatal16 = new TextDecoder("utf-16le", { fatal: true });
check("fatal utf16 odd waits", fatal16.decode(bytes([0x00]), { stream: true }) === "");
check("fatal utf16 odd combines", fatal16.decode(bytes([0x00])) === "\0");
check(
	"fatal utf16 surrogate waits",
	fatal16.decode(bytes([0x00, 0xd8]), { stream: true }) === "",
);
check(
	"fatal utf16 surrogate flush throws",
	throwsTypeError(() => fatal16.decode()),
);
check("fatal utf16 reusable", fatal16.decode(bytes([0x61, 0x00])) === "a");

const optionState = new TextDecoder();
check(
	"throwing options setup",
	optionState.decode(bytes([0xe2]), { stream: true }) === "",
);
check(
	"throwing stream getter propagates",
	throwsTypeError(() =>
		optionState.decode(bytes([]), {
			get stream() {
				throw new TypeError("stream getter");
			},
		}),
	),
);
check(
	"throwing getter leaves stream state",
	optionState.decode(bytes([0x82, 0xac])) === "€",
);

let getterRead = false;
check(
	"BufferSource conversion precedes options",
	throwsTypeError(() =>
		optionState.decode(1, {
			get stream() {
				getterRead = true;
				return true;
			},
		}),
	) && !getterRead,
);
check(
	"primitive options reject",
	throwsTypeError(() => optionState.decode(bytes([]), 1)),
);
check("null options are empty dictionary", optionState.decode(bytes([]), null) === "");

const detachInput = new Uint8Array([0x61]);
check(
	"options conversion can detach input",
	new TextDecoder().decode(detachInput, {
		get stream() {
			detachInput.buffer.transfer(0);
			return false;
		},
	}) === "",
);

const framed = new Uint8Array([0xff, 0xf0, 0x9f, 0x92, 0xa9, 0xff]);
const windowed = new TextDecoder();
check(
	"streaming DataView window",
	windowed.decode(new DataView(framed.buffer, 1, 3), { stream: true }) === "" &&
		windowed.decode(new DataView(framed.buffer, 4, 1)) === "💩",
);

let passed = 0;
for (const [name, ok] of results) {
	if (ok) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
