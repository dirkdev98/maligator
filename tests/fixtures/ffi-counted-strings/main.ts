/* oxlint-disable no-console -- The fixture reports native conversion behavior. */
import {
	text_length,
	text_nullable,
	text_legacy,
	text_many,
	text_narrow,
	text_plain,
	text_plain_max,
	text_plain_async,
	text_copy,
	text_view,
	text_invalid,
	text_bad_count,
	text_callback,
	text_counted_callback,
	text_live,
	text_calls,
	text_copy_async,
	text_view_async,
	text_bad_count_async,
} from "maligator:ffi/text";

function check(value: boolean, message: string): void {
	if (!value) throw new Error(message);
}
function rejects(body: () => unknown, kind: new (message?: string) => Error): void {
	let caught = false;
	try {
		body();
	} catch (error) {
		caught = error instanceof kind;
	}
	check(caught, "expected conversion failure");
}

check(text_length("Grüße🙂") === 11, "counts UTF-8 bytes");
check(text_length("a\0b") === 3, "embedded NUL counts as a byte");
check(
	text_nullable(null) === 1 && text_nullable("") === 2,
	"null differs from empty counted text",
);
check(text_legacy(null) === -1 && text_legacy("") === 0, "nullable legacy strings");
const beforeNul = text_calls();
rejects(() => text_legacy("a\0b"), TypeError);
rejects(() => text_legacy(`${"x".repeat(127)}\0`), TypeError);
check(text_calls() === beforeNul, "legacy NUL rejection precedes C");
const beforeOverflow = text_calls();
rejects(() => text_narrow("é".repeat(128)), RangeError);
check(text_calls() === beforeOverflow, "byte count overflow precedes C");
const plainMax = text_plain_max();
check(
	text_plain("x".repeat(plainMax)) === plainMax,
	"plain char count follows target ABI",
);
rejects(() => text_plain("x".repeat(plainMax + 1)), RangeError);
check(
	(await text_plain_async("x".repeat(plainMax))) === plainMax,
	"async plain char count follows target ABI",
);
for (const value of [
	"",
	"a\0b",
	"Grüße🙂",
	"é".repeat(300),
	"\ud800x",
	...[85, 86, 255, 256].map((length) => "x".repeat(length)),
	"é".repeat(128),
]) {
	const expected = value === "\ud800x" ? "\ufffdx" : value;
	check(text_copy(value) === expected, "owned counted result round trip");
	check(text_live() === 0, "owned counted results are released");
	check(text_view(value) === expected, "borrowed input and result share one count");
}
check(
	text_many(["x".repeat(128), "x".repeat(255), "é".repeat(128), "x".repeat(256)]) === 895,
	"array strings retain their owned encodings at inline boundaries",
);
check(text_copy(null) === null && text_view(null) === null, "null counted results");
check(
	text_invalid() === "f\ufffd\0é",
	"invalid UTF-8 uses replacement and preserves NUL",
);
for (const mode of [0, 1]) {
	rejects(() => text_bad_count(mode), RangeError);
	check(text_live() === 0, "invalid result lengths still release C memory");
}
const failure = new Error("counted callback failure");
let sameFailure = false;
try {
	text_callback(() => {
		throw failure;
	});
} catch (error) {
	sameFailure = error === failure;
}
check(
	sameFailure && text_live() === 0,
	"callback failure releases the unread counted result",
);
let callbackText: string | null = "";
text_counted_callback((text) => {
	callbackText = text;
}, 0);
check(callbackText === "a\0é", "counted callbacks copy unterminated UTF-8 with NUL");
text_counted_callback((text) => {
	callbackText = text;
}, 1);
check(callbackText === null, "null counted callback text");
let invalidCalls = 0;
for (const mode of [2, 3])
	rejects(
		() =>
			text_counted_callback(() => {
				invalidCalls++;
			}, mode),
		RangeError,
	);
check(invalidCalls === 0, "invalid callback lengths fail before entering JavaScript");
sameFailure = false;
try {
	text_counted_callback(() => {
		throw failure;
	}, 0);
} catch (error) {
	sameFailure = error === failure;
}
check(sameFailure, "counted callback preserves the thrown exception");

const long = "é\0🙂".repeat(300);
const pending = [
	text_view_async("x\0y"),
	text_copy_async(long),
	text_view_async(long),
	text_copy_async(null),
	text_view_async("x".repeat(255)),
];
Array.from({ length: 100 }, () => ({ held: new Uint8Array(128) }));
const results = await Promise.all(pending);
check(
	results[0] === "x\0y" &&
		results[1] === long &&
		results[2] === long &&
		results[3] === null &&
		results[4] === "x".repeat(255),
	"async strings retain inline and heap encodings",
);
check(text_live() === 0, "async owned strings are released");
let asyncRejected = false;
try {
	await text_bad_count_async(0);
} catch (error) {
	asyncRejected = error instanceof RangeError;
}
check(
	asyncRejected && text_live() === 0,
	"async decoding failure releases C memory and rejects",
);
console.log("counted strings passed");
