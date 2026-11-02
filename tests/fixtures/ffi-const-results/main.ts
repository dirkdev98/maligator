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
	immutable_token_make,
	makeTokenAsync,
	immutable_token_borrow,
	borrowTokenAsync,
	immutable_token_destroyed,
	immutable_token_destroy_sum,
	immutable_token_address,
	immutable_token_visit,
	visitTokenAsync,
	immutable_token_consume,
	consumeTokenAsync,
	immutable_token_destroy,
	destroyTokenAsync,
	immutable_token_with_callback,
	consumeTokenWithCallbackAsync,
	immutable_token_set,
} from "maligator:ffi/const_values";
import type { Immutable, ImmutableToken } from "maligator:ffi/const_values";

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
for (const token of [immutable_token_make(3), await makeTokenAsync(11)]) {
	check(
		token.detail === token.token + 1 && immutable_token_address(token) % 64n === 0n,
		"copied const handles keep values and native alignment",
	);
	token[Symbol.dispose]();
	token[Symbol.dispose]();
	let closed = false;
	try {
		immutable_token_address(token);
	} catch (error) {
		closed = error instanceof TypeError;
	}
	check(closed, "disposed const handle cannot reach C");
}
check(
	immutable_token_destroyed() === 2 && immutable_token_destroy_sum() === 14,
	"owned const copies release exactly once with their native value",
);
for (const token of [immutable_token_borrow(), await borrowTokenAsync()]) {
	check(
		token.token === 99 && token.detail === 100,
		"borrowed const copies keep their values",
	);
	token[Symbol.dispose]();
}
check(
	immutable_token_destroyed() === 2,
	"borrowed const copies do not release C resources",
);
let escaped: ImmutableToken | undefined;
const receive = (token: ImmutableToken): void => {
	check(token.token === 7 && token.detail === 8, "const callback handle value");
	escaped = token;
};
function readToken(token: ImmutableToken): number {
	return token.token;
}
function checkExpired(token: ImmutableToken | undefined): void {
	check(token !== undefined, "const handle callback ran");
	let expired = false;
	try {
		readToken(token);
	} catch (error) {
		expired = error instanceof TypeError;
	}
	check(expired, "copied callback handles expire with their invocation");
}
immutable_token_visit(7, receive);
checkExpired(escaped);
escaped = undefined;
await visitTokenAsync(7, receive);
checkExpired(escaped);
check(
	immutable_token_destroyed() === 2,
	"queued const callback handles preserve borrowed lifetime",
);
const consumed = immutable_token_make(13);
check(immutable_token_consume(consumed) === 27, "const handle input by value");
check((await consumeTokenAsync(consumed)) === 27, "worker const handle input by value");
const updateDuringCall = (): void => {
	let pinned = false;
	try {
		consumed[Symbol.dispose]();
	} catch (error) {
		pinned = error instanceof TypeError;
	}
	check(pinned, "copied const handle stays pinned during the C call");
	immutable_token_set(consumed, 41);
};
check(
	immutable_token_with_callback(consumed, updateDuringCall) === 27 &&
		consumed.detail === 41,
	"native value input is a snapshot before callback mutation",
);
immutable_token_set(consumed, 14);
check(
	(await consumeTokenWithCallbackAsync(consumed, updateDuringCall)) === 27 &&
		consumed.detail === 41,
	"worker value input owns its snapshot before callback mutation",
);
immutable_token_destroy(consumed);
check(
	immutable_token_destroyed() === 3 && immutable_token_destroy_sum() === 27,
	"explicit const-value destructor closes its handle once",
);
const closing = immutable_token_make(17);
const destroyed = destroyTokenAsync(closing);
let closingRejected = false;
try {
	immutable_token_consume(closing);
} catch (error) {
	closingRejected = error instanceof TypeError;
}
check(closingRejected, "worker destruction rejects new const-value uses");
await destroyed;
closing[Symbol.dispose]();
check(
	immutable_token_destroyed() === 4 && immutable_token_destroy_sum() === 44,
	"worker const-value destructor releases its copy exactly once",
);
console.log("const results passed");
