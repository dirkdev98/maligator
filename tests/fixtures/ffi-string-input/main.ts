/* oxlint-disable no-console -- The fixture reports observable C behavior. */
import {
	input_length,
	input_length_async,
	input_count,
	input_after,
	input_mutate,
	input_alias,
} from "maligator:ffi/input";

function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}
function owned(size: number): string {
	return new TextDecoder().decode(new Uint8Array(size).fill(120));
}
function utf16Bridge(text: string): string {
	// oxlint-disable-next-line typescript/no-deprecated -- This wrapper forces the runtime's UTF16 bridge.
	return text.bold();
}
for (const size of [
	0, 64, 255, 256, 257, 4095, 4096, 5120, 6144, 7168, 8191, 8192, 65535, 65536,
]) {
	const text = owned(size);
	const expected = "x".repeat(size);
	for (let call = 0; call < 32; call++) {
		check(input_length(text) === size, "repeated terminated input");
		check(input_count(text) === size * 120, "repeated counted input");
	}
	check(input_length(text) === size && text === expected, "input survives collection");
	check(input_mutate(text) === size && text === expected, "mutable input is a copy");
	check(input_alias(text) === expected, "input aliases convert before cleanup");
	check(text.repeat(2) === expected + expected, "repetition preserves prepared input");
	const keys = new Map([[text, size]]);
	check(keys.get(expected) === size, "prepared strings remain content-correct keys");
	check(/^x*$/.test(text), "regexp reads prepared string storage");
	check(
		utf16Bridge(text) === `<b>${expected}</b>`,
		"UTF16 bridging preserves prepared input",
	);
	check(input_length(text) === size, "input remains valid after widening");
}
for (const calls of [1, 2, 3, 15]) {
	const text = owned(4096);
	for (let call = 0; call < calls; call++)
		check(input_length(text) === 4096, "pending ASCII preparation preserves input");
	const slice = text.slice(1, -1);
	const keys = new Map([[text, calls]]);
	check(
		utf16Bridge(text) === `<b>${"x".repeat(4096)}</b>`,
		"pending ASCII input can widen",
	);
	check(
		slice.length === 4094 && /^x+$/.test(slice),
		"dependent input survives pending widening",
	);
	check(keys.get("x".repeat(4096)) === calls, "pending input keeps its content hash");
	check(input_length(text) === 4096, "widened pending input converts again");
}
const getterText = owned(8191);
check(input_length(getterText) === 8191, "prepare input before later argument getters");
let getters = 0;
check(
	input_after(getterText, {
		get offset() {
			getters++;
			check(utf16Bridge(getterText).length === 8198, "getter widens earlier input");
			return 7;
		},
	}) === 8198 && getters === 1,
	"later argument getters cannot invalidate C string inputs",
);
const asyncText = owned(65535);
check(input_length(asyncText) === 65535, "prepare input before worker call");
const pending = input_length_async(asyncText);
check(utf16Bridge(asyncText).length === 65542, "widen while worker owns its input");
check((await pending) === 65535, "worker owns its UTF8 input");
for (const text of [
	"é".repeat(300),
	"☃".repeat(300),
	"😀".repeat(300),
	"x".repeat(400) + "y".repeat(400),
]) {
	const expected = new TextEncoder().encode(text).length;
	check(input_length(text) === expected, "UTF8 encoding preserves non-ASCII and ropes");
	check(
		input_length(text.slice(1, -1)) ===
			new TextEncoder().encode(text.slice(1, -1)).length,
		"dependent slices preserve UTF8 input",
	);
}
// Short strings keep their UTF8 inline until reuse earns them a sidecar, long ones on the heap.
for (const original of ["é", "☃", "😀"].flatMap((unit) => [
	unit.repeat(20),
	unit.repeat(4095),
])) {
	const bytes = new TextEncoder().encode(original);
	const text = new TextDecoder().decode(bytes);
	const sum = bytes.reduce((total, byte) => total + byte, 0);
	for (let call = 0; call < 4; call++) {
		check(
			input_length(text) === bytes.length,
			"reused Unicode input keeps its byte length",
		);
		check(input_count(text) === sum, "reused Unicode input keeps its encoding");
	}
	check(
		input_mutate(text) === bytes.length && text === original,
		"mutable Unicode input remains a copy",
	);
	check(input_alias(text) === original, "Unicode aliases copy before cleanup");
	check(
		input_length(text.slice(1, -1)) ===
			new TextEncoder().encode(text.slice(1, -1)).length,
		"slicing encoded strings keeps UTF16 offsets",
	);
	const keys = new Map([[text, 1]]);
	keys.set(new TextDecoder().decode(bytes), 2);
	check(
		keys.get(original) === 2 && text.repeat(2) === original + original,
		"prepared Unicode strings preserve content semantics",
	);
	check(
		input_after(text, {
			get offset() {
				check(
					utf16Bridge(text) === `<b>${original}</b>`,
					"later getter bridges prepared Unicode",
				);
				return 7;
			},
		}) ===
			bytes.length + 7,
		"later getters cannot invalidate Unicode arguments",
	);
	check(input_length(text) === bytes.length, "Unicode input survives UTF16 bridging");
	const workerText = new TextDecoder().decode(bytes);
	for (let call = 0; call < 3; call++)
		check(input_length(workerText) === bytes.length, "prepare Unicode worker input");
	const pending = input_length_async(workerText);
	check(
		utf16Bridge(workerText) === `<b>${original}</b>`,
		"worker input survives Unicode bridging",
	);
	check((await pending) === bytes.length, "worker owns encoded Unicode input");
}
for (const text of [
	"é",
	"é".repeat(127),
	"é".repeat(128),
	"é".repeat(200),
	"é".repeat(255),
	`x${"é".repeat(254)}`,
	"☃".repeat(7),
	"😀".repeat(5),
	"aé☃😀\ud800x",
	"a\ud83d",
	"\ude00b",
	"\u07ff\u0800\uffff",
]) {
	const bytes = new TextEncoder().encode(text);
	check(
		input_count(text) === bytes.reduce((total, byte) => total + byte, 0),
		"short and boundary-length Unicode inputs encode exactly",
	);
}
const surrogate = String.fromCharCode(...new Array<number>(300).fill(0xd800));
const surrogateBytes = new TextEncoder().encode(surrogate);
for (let call = 0; call < 3; call++)
	check(
		input_count(surrogate) === surrogateBytes.reduce((total, byte) => total + byte, 0),
		"lone surrogate encodings remain stable",
	);
const countedUnicode = new TextDecoder().decode(
	new TextEncoder().encode(`${"é".repeat(300)}\0☃`),
);
const countedBytes = new TextEncoder().encode(countedUnicode);
for (let call = 0; call < 3; call++)
	check(
		input_count(countedUnicode) === countedBytes.reduce((total, byte) => total + byte, 0),
		"counted Unicode input retains embedded NUL",
	);
let rejectedUnicodeNul = false;
try {
	input_length(countedUnicode);
} catch (error) {
	rejectedUnicodeNul = error instanceof TypeError;
}
check(rejectedUnicodeNul, "terminated use rejects NUL after counted Unicode use");
const nulBytes = new Uint8Array(8191).fill(120);
nulBytes[4096] = 0;
const nul = new TextDecoder().decode(nulBytes);
check(input_count(nul) === 8190 * 120, "counted input retains embedded NUL");
let refused = false;
try {
	input_length(nul);
} catch (error) {
	refused = error instanceof TypeError;
}
check(refused, "terminated input rejects embedded NUL");
console.log("string inputs passed");
