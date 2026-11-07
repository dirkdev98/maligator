/* oxlint-disable no-console -- The fixture reports struct pointer handles. */
import {
	style_destroy,
	style_destroyed,
	style_new,
	style_set_flags,
	style_shared,
	style_weight,
} from "maligator:ffi/styles";

function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}

{
	using style = style_new();
	check(style !== null, "constructor result");
	check(style_weight(style) === 1.5, "by-value calls copy the library's struct");
	style_set_flags(style, 7);
	check(style.flags === 7, "fields read the library's storage");
	check(style_weight(style) === 1.5 && style_destroyed() === 0, "still open");
}
check(style_destroyed() === 1, "disposal releases through the destructor");

const explicit = style_new()!;
style_destroy(explicit);
check(style_destroyed() === 2, "the destroy binding releases once");
let caught: unknown;
try {
	style_weight(explicit);
} catch (error) {
	caught = error;
}
check(caught instanceof TypeError, "a destroyed handle is closed");

const shared = style_shared()!;
check(style_weight(shared) === 2 && shared.flags === 1, "borrowed struct pointer");
shared[Symbol.dispose]();
check(style_destroyed() === 2, "closing a borrowed handle leaves the library's struct");

console.log("struct pointers passed");
