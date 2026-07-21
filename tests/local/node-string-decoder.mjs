import stringDecoderModule, { StringDecoder } from "node:string_decoder";

const results = [];
function check(name, value) {
	results.push([name, !!value]);
}
function throwsTypeError(name, fn) {
	let error;
	try {
		fn();
	} catch (caught) {
		error = caught;
	}
	check(name, error instanceof TypeError);
}

check("default module object", stringDecoderModule.StringDecoder === StringDecoder);

check(
	"canonical encoding labels",
	new StringDecoder().encoding === "utf8" &&
		new StringDecoder("UTF-8").encoding === "utf8" &&
		new StringDecoder("ucs2").encoding === "utf16le" &&
		new StringDecoder("ucs-2").encoding === "utf16le" &&
		new StringDecoder("utf-16le").encoding === "utf16le" &&
		new StringDecoder("binary").encoding === "latin1" &&
		new StringDecoder("BASE64").encoding === "base64" &&
		new StringDecoder("hex").encoding === "hex",
);

const splitUtf8 = new StringDecoder("utf8");
check(
	"split valid UTF-8 sequences",
	splitUtf8.write(Buffer.from([0xc2])) === "" &&
		splitUtf8.write(new Uint8Array([0xa2, 0xe2])) === "¢" &&
		splitUtf8.write(Buffer.from([0x82])) === "" &&
		splitUtf8.write(Buffer.from([0xac, 0xf0, 0x9f, 0x98])) === "€" &&
		splitUtf8.write(Buffer.from([0x80])) === "😀" &&
		splitUtf8.end() === "",
);

const malformed = new StringDecoder("utf8");
check(
	"malformed and overlong UTF-8",
	malformed.write(Buffer.from([0xc0])) === "" &&
		malformed.write(Buffer.from([0x80])) === "��" &&
		malformed.write(Buffer.from([0xed])) === "" &&
		malformed.write(Buffer.from([0xa0])) === "" &&
		malformed.write(Buffer.from([0x80])) === "���" &&
		malformed.write(Buffer.from([0xf4, 0x90, 0x80])) === "" &&
		malformed.write(Buffer.from([0x80])) === "����" &&
		malformed.end() === "",
);

const invalidContinuation = new StringDecoder();
check(
	"invalid continuation preserves following bytes",
	invalidContinuation.write(Buffer.from([0xe1, 0x80])) === "" &&
		invalidContinuation.write(Buffer.from([0x41])) === "�A" &&
		invalidContinuation.end() === "",
);

const incomplete = new StringDecoder();
check(
	"incomplete end flush",
	incomplete.write(Buffer.from([0xe2, 0x82])) === "" && incomplete.end() === "�",
);

const optionalEnd = new StringDecoder();
check(
	"end accepts a final byte source and resets",
	optionalEnd.write(Buffer.from([0xe2])) === "" &&
		optionalEnd.end(new Uint8Array([0x82, 0xac])) === "€" &&
		optionalEnd.write(Buffer.from("again")) === "again" &&
		optionalEnd.end() === "" &&
		optionalEnd.end() === "",
);

const pair = new StringDecoder("utf16le");
check(
	"UTF-16LE retains a high surrogate",
	pair.write(Buffer.from([0x3d, 0xd8])) === "" &&
		pair.write(Buffer.from([0x00, 0xde])) === "😀" &&
		pair.end() === "",
);

const byteSplitHigh = new StringDecoder("utf16le");
const completedHigh =
	byteSplitHigh.write(Buffer.from([0x3d])) + byteSplitHigh.write(Buffer.from([0xd8]));
check(
	"UTF-16LE emits a high surrogate completed from an odd byte",
	completedHigh.length === 1 &&
		completedHigh.charCodeAt(0) === 0xd83d &&
		byteSplitHigh.end() === "",
);

const oddUtf16 = new StringDecoder("ucs2");
const highThenOdd = oddUtf16.write(Buffer.from([0x3d, 0xd8, 0x41]));
check(
	"UTF-16LE retains an odd trailing byte",
	highThenOdd.length === 1 &&
		highThenOdd.charCodeAt(0) === 0xd83d &&
		oddUtf16.write(Buffer.from([0x00])) === "A" &&
		oddUtf16.end() === "",
);

const partialPair = new StringDecoder("utf16le");
const partialPairEnd =
	partialPair.write(Buffer.from([0x3d, 0xd8])) +
	partialPair.write(Buffer.from([0x00])) +
	partialPair.end();
check(
	"UTF-16LE flushes a pending high surrogate and drops an odd byte",
	partialPairEnd.length === 1 && partialPairEnd.charCodeAt(0) === 0xd83d,
);

const base64 = new StringDecoder("base64");
check(
	"base64 retains incomplete triples",
	base64.write(Buffer.from([1])) === "" &&
		base64.write(Buffer.from([2])) === "" &&
		base64.write(Buffer.from([3, 4])) === "AQID" &&
		base64.end() === "BA==",
);
const base64url = new StringDecoder("base64url");
check(
	"base64url retains incomplete triples without padding",
	base64url.write(Buffer.from([0xfb, 0xff])) === "" && base64url.end() === "-_8",
);

check(
	"stateless byte encodings",
	new StringDecoder("latin1").write(Buffer.from([0xe9, 0xff])) === "éÿ" &&
		new StringDecoder("ascii").write(Buffer.from([0xc1, 0xff])) === "A\x7f" &&
		new StringDecoder("hex").write(Buffer.from([0x00, 0xab, 0xff])) === "00abff",
);

check(
	"all ArrayBuffer views use their bytes",
	new StringDecoder().write(new Uint16Array([0x4241])) === "AB" &&
		new StringDecoder().write(new DataView(Uint8Array.of(0x43).buffer)) === "C",
);
const resizedDecoderBuffer = new ArrayBuffer(4, { maxByteLength: 8 });
new Uint8Array(resizedDecoderBuffer).set([65, 66, 67, 68]);
const fixedDecoderView = new DataView(resizedDecoderBuffer, 1, 3);
const trackingDecoderView = new DataView(resizedDecoderBuffer, 1);
resizedDecoderBuffer.resize(3);
check(
	"length-tracking DataView uses its resized window",
	new StringDecoder().write(trackingDecoderView) === "BC",
);
throwsTypeError("write rejects an out-of-bounds DataView", () =>
	new StringDecoder().write(fixedDecoderView),
);
const detachedDecoderBuffer = new ArrayBuffer(1);
const detachedDecoderView = new DataView(detachedDecoderBuffer);
detachedDecoderBuffer.transfer();
throwsTypeError("write rejects a detached DataView", () =>
	new StringDecoder().write(detachedDecoderView),
);

const rawBody = new Uint8Array([
	0, 0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xe2, 0x82, 0xac, 0x22, 0x7d, 0,
]);
const rawDecoder = new StringDecoder("utf-8");
let rawText = "";
for (const chunk of [
	rawBody.subarray(1, 8),
	rawBody.subarray(8, 9),
	rawBody.subarray(9, 12),
]) {
	rawText += rawDecoder.write(chunk);
	for (let i = 0; i < 40; i++) ({ chunk: i, rawText });
}
rawText += rawDecoder.end();
check("raw-body style Uint8Array writes honor view offsets", rawText === '{"x":"€"}');

class DerivedDecoder extends StringDecoder {}
const derived = new DerivedDecoder("utf8");
check(
	"derived construction preserves branding",
	derived instanceof StringDecoder && derived.write(Buffer.from("ok")) === "ok",
);

check(
	"Node-compatible method descriptors",
	StringDecoder.length === 1 &&
		StringDecoder.prototype.write.length === 1 &&
		StringDecoder.prototype.end.length === 1 &&
		Object.getOwnPropertyDescriptor(StringDecoder.prototype, "write").enumerable &&
		Object.getOwnPropertyDescriptor(StringDecoder, "prototype").writable &&
		Object.getOwnPropertyDescriptor(derived, "encoding").enumerable,
);

throwsTypeError("constructor requires new", () => StringDecoder("utf8"));
throwsTypeError("unknown encoding rejects", () => new StringDecoder("wat"));
throwsTypeError("write validates byte source", () => new StringDecoder().write({}));
throwsTypeError("write checks receiver branding", () =>
	StringDecoder.prototype.write.call({}, Buffer.from("x")),
);
throwsTypeError("end checks receiver branding", () =>
	StringDecoder.prototype.end.call({}),
);

let passed = 0;
for (const [name, ok] of results) {
	if (ok) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
