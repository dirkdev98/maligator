/* oxlint-disable no-console -- The fixture reports end pointer ranges. */
import {
	nullable_bytes,
	textBytesAsync,
	text_bytes,
	wrap_position,
} from "maligator:ffi/ranges";

function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}

check(wrap_position("hello world", 5) === " world", "wrap inside the text");
check(wrap_position("hello", 10) === "", "wrap at the end");
check(text_bytes("héllo ✓") === 10, "the end follows UTF-8 bytes");
check(text_bytes("") === 0, "an empty text ends where it starts");
check((await textBytesAsync("✓✓")) === 6, "async text range");
check(nullable_bytes("abc") === 3, "nullable text range");
check(nullable_bytes(null) === -1, "a null text has a null end");

console.log("end pointers passed");
