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
	text_out,
	text_out_async,
	text_out_bad,
	text_out_bad_async,
	text_out_callback,
	text_out_callback_async,
	text_advance,
	text_advance_async,
	text_advance_first,
	text_advance_first_async,
	text_inout_copy,
	text_inout_copy_async,
	text_inout_fixed,
	text_inout_fixed_async,
	text_notify,
	text_notify_async,
	text_wait_async,
	text_mixed_notify,
	text_mixed_notify_async,
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
const out = text_out();
const outAsync = await text_out_async();
check(out.text === "a\0é" && out.length === 4, "out text uses C's updated byte count");
check(outAsync.text === out.text && outAsync.length === out.length, "async out parity");
check(text_live() === 0, "out conversions release owned buffers");
for (const input of ["é\0🙂", "x".repeat(255), "é".repeat(300), "", null]) {
	const skip = input === null || input.length === 0 ? 0 : input.startsWith("é") ? 2 : 1;
	const expected = input === null ? null : input.slice(skip === 2 ? 1 : skip);
	const advanced = text_advance(input, skip);
	const asyncAdvanced = await text_advance_async(input, skip);
	check(
		advanced.text === expected && asyncAdvanced.text === expected,
		"inout cursors retain encodings",
	);
	check(advanced.length === asyncAdvanced.length, "updated byte counts agree");
	const copied = text_inout_copy(input);
	const asyncCopied = await text_inout_copy_async(input);
	check(
		copied.text === input && asyncCopied.text === input,
		"inout results may own a new allocation",
	);
	check(text_live() === 0, "new inout allocations are released");
}
check(
	text_inout_fixed("a\0b").text === "z\0b",
	"by-value counts initialize from the encoding",
);
const reversed = text_advance_first("é\0🙂", 2);
const reversedAsync = await text_advance_first_async("é\0🙂", 2);
check(
	reversed.length === 5 &&
		reversed.text === "\0🙂" &&
		reversedAsync.length === 5 &&
		reversedAsync.text === "\0🙂",
	"a count can precede its text pointer",
);
check(
	(await text_inout_fixed_async("a\0b")).text === "z\0b",
	"async by-value count parity",
);
rejects(() => text_inout_fixed("é".repeat(128)), RangeError);
rejects(() => text_advance("text", -1), RangeError);
for (const mode of [0, 1]) {
	rejects(() => text_out_bad(mode), RangeError);
	let rejected = false;
	try {
		await text_out_bad_async(mode);
	} catch (error) {
		rejected = error instanceof RangeError;
	}
	check(rejected && text_live() === 0, "failed out conversion releases the allocation");
}
sameFailure = false;
try {
	text_out_callback(() => {
		throw failure;
	});
} catch (error) {
	sameFailure = error === failure;
}
check(sameFailure && text_live() === 0, "a thrown callback releases unobserved out text");
sameFailure = false;
try {
	await text_out_callback_async(() => {
		throw failure;
	});
} catch (error) {
	sameFailure = error === failure;
}
check(sameFailure && text_live() === 0, "async callback failure releases out text");
for (const [mode, expectedText] of [
	[0, "a\0é"],
	[1, null],
	[4, ""],
] as const) {
	const notified = await new Promise<string | null>((resolve) => {
		text_notify(resolve, mode);
	});
	check(
		notified === expectedText,
		"notifications own an exact UTF-8 copy after C overwrites its source",
	);
	let waited: string | null | undefined;
	await text_wait_async((value) => {
		waited = value;
	}, mode);
	check(
		waited === expectedText,
		"waiting callbacks borrow counted text until conversion",
	);
}
for (const deliver of [text_notify_async, text_wait_async]) {
	for (const mode of [2, 3]) {
		let rejected = false;
		let calls = 0;
		try {
			await deliver(() => {
				calls++;
			}, mode);
		} catch (error) {
			rejected = error instanceof RangeError;
		}
		check(
			rejected && calls === 0,
			"invalid foreign lengths reject before copying or entering JavaScript",
		);
	}
}
const mixed = await new Promise<readonly [string | null, string | null]>((resolve) => {
	text_mixed_notify((legacy, counted) => {
		resolve([legacy, counted]);
	}, 0);
});
check(
	mixed[0] === "cold" && mixed[1] === "a\0é",
	"legacy and counted copies have independent ownership",
);
for (const mode of [2, 3]) {
	let rejected = false;
	let called = false;
	try {
		await text_mixed_notify_async(() => {
			called = true;
		}, mode);
	} catch (error) {
		rejected = error instanceof RangeError;
	}
	check(rejected && !called, "a failed counted copy also retires earlier legacy copies");
}
console.log("counted strings passed");
