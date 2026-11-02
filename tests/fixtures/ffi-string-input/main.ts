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
for (const size of [0, 64, 255, 256, 257, 4095, 4096, 8191, 8192, 65535, 65536]) {
	const text = owned(size);
	const expected = "x".repeat(size);
	for (let call = 0; call < 3; call++) {
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
