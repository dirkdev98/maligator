/* oxlint-disable no-console -- The fixture reports C input validation. */
import {
	pair_dot,
	dotAsync,
	pair_bytes,
	bytesAsync,
	pair_mixed,
	mixedAsync,
	pair_reversed,
	reversedAsync,
	pair_text,
	textAsync,
	pair_calls,
	pair_reset,
} from "maligator:ffi/pairs";

function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}
async function rejects(
	run: () => unknown,
	type: typeof TypeError | typeof RangeError = TypeError,
): Promise<void> {
	pair_reset();
	let caught: unknown;
	try {
		await run();
	} catch (error) {
		caught = error;
	}
	check(caught instanceof type, `expected ${type.name}, got ${String(caught)}`);
	check(pair_calls() === 0, "inconsistent input reached C");
}

for (const dot of [pair_dot, dotAsync]) {
	check((await dot([2, 3], [5, 7])) === 31, "matching vectors");
	check(
		(await dot([], [])) === 0 &&
			(await dot(null, [])) === 0 &&
			(await dot([], null)) === 0,
		"empty and nullable vectors",
	);
	await rejects(() => dot([2], [5, 7]));
	await rejects(() => dot([2, 3], [5]));
	await rejects(() => dot(null, [5]));
	await rejects(() => dot(new Array(256).fill(1), new Array(256).fill(2)), RangeError);
}
for (const bytes of [pair_bytes, bytesAsync]) {
	check(
		(await bytes(new Uint8Array([2, 3]), new Uint8Array([5, 7]), null)) === 31,
		"matching spans",
	);
	check((await bytes(null, new Uint8Array(), null)) === 0, "nullable spans");
	const buffer = new ArrayBuffer(2);
	await rejects(() =>
		bytes(buffer, new Uint8Array(1), () => {
			throw new Error("must not call back");
		}),
	);
	check(buffer.transfer().byteLength === 2, "failed comparison releases buffer pins");
}
for (const mixed of [pair_mixed, mixedAsync]) {
	check((await mixed([2, 3], new Uint8Array([5, 7]))) === 31, "mixed matching inputs");
	await rejects(() => mixed([2], new Uint8Array(2)));
	await rejects(() => mixed([2, 3], new Uint8Array(1)));
}
for (const mixed of [pair_reversed, reversedAsync]) {
	check((await mixed(new Uint8Array([5, 7]), [2, 3])) === 31, "reversed matching inputs");
	await rejects(() => mixed(new Uint8Array(1), [2, 3]));
	const detached = new ArrayBuffer(2);
	const detaching = [2, 3];
	Object.defineProperty(detaching, "0", {
		get() {
			detached.transfer();
			return 2;
		},
	});
	await rejects(() => mixed(detached, detaching));
	const resized = new ArrayBuffer(2, { maxByteLength: 4 });
	const values = [2, 3];
	Object.defineProperty(values, "0", {
		get() {
			resized.resize(1);
			return 2;
		},
	});
	await rejects(() => mixed(resized, values));
}
for (const text of [pair_text, textAsync]) {
	check(
		(await text("é", new Uint8Array([1, 1]))) === 364,
		"shared text count measures UTF-8 bytes",
	);
	await rejects(() => text("é", new Uint8Array(1)));
}
console.log("shared input counts passed");
