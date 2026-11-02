/* oxlint-disable no-console -- The fixture reports observable C ABI behavior. */
import {
	a_make,
	makeAsync,
	z_make_before,
	makeBeforeAsync,
	getFixed,
	immutable_visit,
	visitAsync,
	notifyAsync,
} from "maligator:ffi/const_values";
import type { Immutable } from "maligator:ffi/const_values";

function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}
function verify(value: Immutable, seed: number): void {
	check(value.code === seed, "const scalar result");
	check(
		value.nested.value === seed + 1 && value.nested.writable === seed + 2,
		"nested const result",
	);
	check(
		value.samples[0] === seed + 3 && value.samples[1] === seed + 4,
		"const array result",
	);
	check(value.promoted === seed + 5, "promoted const result");
}
for (const seed of [-3, 0, 7, 19]) {
	verify(a_make(seed), seed);
	verify(await makeAsync(seed), seed);
	check(
		z_make_before(seed).value === seed + 10,
		"input rejection does not poison later output",
	);
	check(
		(await makeBeforeAsync(seed)).value === seed + 10,
		"worker initializes const record",
	);
	check(
		immutable_visit(seed, (value) => {
			verify(value, seed);
			return value.promoted;
		}) ===
			seed * 2 + 5,
		"synchronous callback const argument",
	);
	check(
		(await visitAsync(seed, (value) => {
			verify(value, seed);
			return value.promoted;
		})) ===
			seed * 2 + 5,
		"waiting callback initializes its const argument",
	);
	let received: (() => void) | undefined;
	const notified = new Promise<void>((resolve) => {
		received = resolve;
	});
	await notifyAsync(seed, (value) => {
		verify(value, seed);
		received!();
	});
	await notified;
}
verify(getFixed(), 77);
let caught = false;
try {
	immutable_visit(3, () => {
		throw new Error("immutable callback error");
	});
} catch (error) {
	caught = error instanceof Error && error.message === "immutable callback error";
}
check(caught, "callback failure preserves const argument cleanup");
console.log("const results passed");
