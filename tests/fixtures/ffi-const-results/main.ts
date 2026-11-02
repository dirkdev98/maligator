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
	a_take_before,
	takeBeforeAsync,
	z_take,
	takeAsync,
	immutable_bits_take,
	takeBitsAsync,
	immutable_taken,
	immutable_out,
	outAsync,
	immutable_inout,
	inoutAsync,
	immutable_token_out,
	tokenOutAsync,
	immutable_token_out_visit,
	tokenOutVisitAsync,
	immutable_array,
	arrayAsync,
	immutable_token_array,
	tokenArrayAsync,
	immutable_array_out,
	arrayOutAsync,
	immutable_pair_out,
	pairOutAsync,
	immutable_pair_many,
	pairManyAsync,
	immutable_pair_inout,
	pairInoutAsync,
	immutable_numbers_out,
	numbersOutAsync,
	immutable_grid_out,
	gridOutAsync,
	immutable_grid_inout,
	gridInoutAsync,
	immutable_choice_int,
	choiceIntAsync,
	immutable_choice_take_int,
	takeChoiceIntAsync,
	immutable_choice_record,
	choiceRecordAsync,
	immutable_choice_take_record,
	takeChoiceRecordAsync,
	immutable_choice_array,
	choiceArrayAsync,
	immutable_choice_take_array,
	takeChoiceArrayAsync,
	immutable_choice_out,
	choiceOutAsync,
	immutable_choice_inout,
	choiceInoutAsync,
	immutable_choice_sum,
	choiceSumAsync,
	immutable_envelope_take,
	immutable_callback_result,
	callbackResultAsync,
	immutable_callback_check,
	callbackCheckAsync,
	immutable_callback_zeroes,
	callbackParallelAsync,
	immutable_choice_callback,
	immutable_callback_replace,
	callbackReplacedAsync,
	choiceCallbackAsync,
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
	check(
		value.points[0].value === seed + 6 && value.points[1].writable === seed + 9,
		"array of const records",
	);
}
for (const seed of [-3, 0, 7, 19]) {
	verify(a_make(seed), seed);
	check(
		z_take(a_make(seed)) === seed * 10 + 45,
		"plain const input initializes every field",
	);
	check(
		(await takeAsync(a_make(seed))) === seed * 10 + 45,
		"worker const input initializes every field",
	);
	check(a_take_before({ value: seed }) === seed, "small const input");
	check((await takeBeforeAsync({ value: seed })) === seed, "small worker const input");
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
check(
	immutable_choice_int(-7) === -7 && (await choiceIntAsync(9)) === 9,
	"const union scalar results",
);
check(
	immutable_choice_take_int(-11) === -11 && (await takeChoiceIntAsync(13)) === 13,
	"const union scalar constructors",
);
verify(immutable_choice_record(3), 3);
verify(await choiceRecordAsync(5), 5);
check(
	immutable_choice_take_record(a_make(3)) === 75 &&
		(await takeChoiceRecordAsync(a_make(5))) === 95,
	"const union record constructors",
);
check(
	immutable_choice_array(7)[1] === 8 && (await choiceArrayAsync(11))[0] === 11,
	"const union fixed array results",
);
check(
	immutable_choice_take_array([17, 19]) === 36 &&
		(await takeChoiceArrayAsync([23, 29])) === 52,
	"const union fixed array constructors",
);
verify(immutable_choice_out(31).value, 31);
verify((await choiceOutAsync(41)).value, 41);
check(
	z_take(immutable_choice_inout(a_make(2)).value) === 165,
	"const union inout preserves active record",
);
check(
	z_take((await choiceInoutAsync(a_make(4))).value) === 185,
	"worker const union inout preserves active record",
);
check(
	immutable_choice_sum([1, 2, 3]) === 6 && (await choiceSumAsync([5, 7])) === 12,
	"const union counted array constructors",
);
check(
	immutable_envelope_take({ id: 11, payload: 13 }) === 24,
	"const unions initialize inside records",
);
let unionRange = false;
try {
	immutable_choice_take_int(1.5);
} catch (error) {
	unionRange = error instanceof RangeError;
}
check(unionRange, "const union constructor preserves scalar range checks");
verify(immutable_out().value, 21);
verify((await outAsync()).value, 21);
for (const output of [
	immutable_array_out().value,
	(await arrayOutAsync()).value,
	immutable_pair_out().value,
	(await pairOutAsync()).value,
]) {
	verify(output[0], 31);
	verify(output[1], 41);
}
for (const async of [false, true]) {
	const input: [Immutable, Immutable] = [a_make(2), a_make(4)];
	const output = async
		? (await pairInoutAsync(input)).value
		: immutable_pair_inout(input).value;
	check(
		z_take(output[0]) === 165 && z_take(output[1]) === 285,
		"fixed inout arrays initialize const record elements",
	);
	verify(input[0], 2);
	verify(input[1], 4);
}
for (const output of [immutable_numbers_out().value, (await numbersOutAsync()).value])
	check(output[0] === 17 && output[1] === 23, "fixed const scalar output arrays");
for (const output of [immutable_grid_out().value, (await gridOutAsync()).value])
	check(output[0][1] === 3 && output[1][0] === 5, "nested fixed const output arrays");
const gridSource: [[number, number], [number, number]] = [
	[11, 13],
	[17, 19],
];
const gridInput = new Proxy(gridSource, {
	get(target, key, receiver): unknown {
		if (key === "0" || key === "1")
			return new Proxy([...target[Number(key)]!], {
				get(row, field, rowReceiver): unknown {
					const garbage = Array.from({ length: 12 }, () => ({
						value: "nested array construction",
					}));
					check(garbage.length === 12, "allocating array element getter");
					return Reflect.get(row, field, rowReceiver);
				},
			});
		return Reflect.get(target, key, receiver);
	},
});
check(
	immutable_grid_inout(gridInput).value[1][1] === 19,
	"nested array getters stay rooted through initialization",
);
check(
	(await gridInoutAsync(gridInput)).value[0][0] === 11,
	"nested const inout array worker snapshots",
);
const beforeFixedFailure = immutable_taken();
let fixedFailed = false;
try {
	immutable_pair_inout([a_make(2), { ...a_make(4), code: 1.5 }]);
} catch (error) {
	fixedFailed = error instanceof RangeError;
}
check(
	fixedFailed && immutable_taken() === beforeFixedFailure,
	"failed fixed array conversion never enters C",
);
for (const async of [false, true]) {
	const input = a_make(5);
	const output = async ? (await inoutAsync(input)).value : immutable_inout(input).value;
	check(
		z_take(output) === 195 && output.code === 5 && output.nested.value === 6,
		"inout initializes const fields and updates mutable members",
	);
	verify(input, 5);
}
const beforeInvalid = immutable_taken();
let invalidOutput = false;
try {
	immutable_inout({ ...a_make(5), code: 1.5 });
} catch (error) {
	invalidOutput = error instanceof RangeError;
}
check(
	invalidOutput && immutable_taken() === beforeInvalid,
	"failed inout construction never reaches C",
);
const pendingInput = a_make(4);
const captured = takeAsync(pendingInput);
pendingInput.code = 1000;
pendingInput.nested.value = 1000;
pendingInput.samples[0] = 1000;
check((await captured) === 85, "worker input snapshots const members before queueing");
const events: Array<string> = [];
const observed = new Proxy(a_make(4), {
	get(target, key, receiver): unknown {
		if (typeof key === "string") events.push(key);
		if (key === "nested")
			return {
				get value() {
					events.push("nested.value");
					return 5;
				},
				get writable() {
					events.push("nested.writable");
					return 6;
				},
			};
		if (key === "points")
			return [0, 1].map(
				(index) =>
					new Proxy(
						{ value: 10 + index * 2, writable: 11 + index * 2 },
						{
							get(point, field, pointReceiver): unknown {
								const garbage = Array.from({ length: 12 }, () => ({
									value: "native construction roots",
								}));
								check(garbage.length === 12, "allocating nested getter");
								return Reflect.get(point, field, pointReceiver);
							},
						},
					),
			);
		return Reflect.get(target, key, receiver);
	},
});
check(
	z_take(observed) === 85,
	"Proxy and allocating nested getters construct const records",
);
check(
	events.join(",") === "code,nested,samples,promoted,points,nested.value,nested.writable",
	"const constructor snapshots immediate fields before nested conversions",
);
const calls = immutable_taken();
for (const mode of ["throw", "range"] as const) {
	let failed = false;
	try {
		z_take(
			new Proxy(a_make(4), {
				get(target, key, receiver): unknown {
					if (key === "code" && mode === "range") return 1.5;
					if (key === "points" && mode === "throw")
						throw new Error("const getter failed");
					return Reflect.get(target, key, receiver);
				},
			}),
		);
	} catch (error) {
		failed =
			mode === "range"
				? error instanceof RangeError
				: error instanceof Error && error.message === "const getter failed";
	}
	check(failed && immutable_taken() === calls, "failed const conversion never calls C");
}
check(z_take(a_make(0)) === 45, "const conversion cleanup permits the next call");
check(
	immutable_bits_take({ code: 7, payload: -3 }) === 4,
	"const bit-field uses native initialization",
);
check(
	(await takeBitsAsync({ code: 1, payload: 2 })) === 3,
	"worker const bit-field input",
);
let bitRange = false;
try {
	immutable_bits_take({ code: 8, payload: 0 });
} catch (error) {
	bitRange = error instanceof RangeError;
}
check(bitRange, "const bit-field keeps its declared range");
for (const count of [0, 1, 2, 5, 9]) {
	const values = Array.from({ length: count }, (_, index) => a_make(index));
	const sum = count * 45 + count * (count - 1) * 5;
	check(
		immutable_array(values) === sum,
		"counted const records use aligned native elements",
	);
	const pending = arrayAsync(values);
	if (count > 0) values[0]!.code = 1000;
	check((await pending) === sum, "worker const array owns its element snapshots");
}
const beforeArrayFailure = immutable_taken();
let arrayFailed = false;
try {
	immutable_array([a_make(0), { ...a_make(1), code: 1.5 }]);
} catch (error) {
	arrayFailed = error instanceof RangeError;
}
check(
	arrayFailed && immutable_taken() === beforeArrayFailure,
	"failed array conversion never enters C",
);
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
for (const token of [immutable_token_out(101).value, (await tokenOutAsync(103)).value]) {
	check(
		token.detail === token.token + 1 && immutable_token_address(token) % 64n === 0n,
		"owned const out handles preserve native alignment",
	);
	token[Symbol.dispose]();
	token[Symbol.dispose]();
}
check(
	immutable_token_destroyed() === 6 && immutable_token_destroy_sum() === 248,
	"owned const out values release exactly once",
);
const failOutput = (): void => {
	throw new Error("const output callback failed");
};
for (const async of [false, true]) {
	let failed = false;
	try {
		if (async) await tokenOutVisitAsync(203, failOutput);
		else immutable_token_out_visit(201, failOutput);
	} catch (error) {
		failed = error instanceof Error && error.message === "const output callback failed";
	}
	check(failed, "const out callback errors reach the caller");
}
check(
	immutable_token_destroyed() === 8 && immutable_token_destroy_sum() === 652,
	"unexposed owned const outputs release after callback failure",
);
const arrayFirst = immutable_token_make(7);
const arraySecond = immutable_token_make(11);
const handleValues = [arrayFirst, arraySecond];
Object.defineProperty(handleValues, 1, {
	get() {
		let pinned = false;
		try {
			arrayFirst[Symbol.dispose]();
		} catch (error) {
			pinned = error instanceof TypeError;
		}
		check(pinned, "const array elements stay pinned through later getters");
		return arraySecond;
	},
});
check(immutable_token_array(handleValues) === 38, "const copied-handle array inputs");
let badHandle = false;
try {
	immutable_token_array([arrayFirst, {} as unknown as ImmutableToken]);
} catch (error) {
	badHandle = error instanceof TypeError;
}
check(badHandle, "invalid copied-handle array element is rejected");
const handleArrayCall = tokenArrayAsync(handleValues);
let arrayPinned = false;
try {
	arrayFirst[Symbol.dispose]();
} catch (error) {
	arrayPinned = error instanceof TypeError;
}
check(
	arrayPinned && (await handleArrayCall) === 38,
	"worker const arrays keep input resources alive",
);
arrayFirst[Symbol.dispose]();
arraySecond[Symbol.dispose]();
check(
	immutable_token_destroyed() === 10 && immutable_token_destroy_sum() === 670,
	"array staging releases pins without duplicating owners",
);
for (const run of [immutable_callback_result, callbackResultAsync]) {
	verify(await run(() => a_make(13)), 13);
}
for (const run of [immutable_choice_callback, choiceCallbackAsync]) {
	verify(await run(() => a_make(17)), 17);
}
check(
	(await callbackParallelAsync((index) => a_make(index))) === 100,
	"concurrent producers receive their initialized const results",
);
for (const run of [immutable_callback_check, callbackCheckAsync]) {
	for (const mode of ["throw", "getter", "range"] as const) {
		const zeroes = immutable_callback_zeroes();
		let calls = 0;
		let failed = false;
		try {
			await run(() => {
				calls++;
				if (mode === "throw") throw new Error("const callback failed");
				if (mode === "range") return { ...a_make(1), code: 1.5 };
				return {
					...a_make(1),
					get code(): number {
						throw new RangeError("const result getter");
					},
				};
			});
		} catch (error) {
			failed =
				mode === "range"
					? error instanceof RangeError
					: error instanceof Error &&
						error.message ===
							(mode === "throw" ? "const callback failed" : "const result getter");
		}
		check(
			failed && calls === 1 && immutable_callback_zeroes() === zeroes + 2,
			"failed const callbacks return native zeroes and skip later JavaScript calls",
		);
	}
}
verify(await callbackResultAsync(() => a_make(19)), 19);
immutable_callback_replace((index) => {
	immutable_callback_replace((next) => a_make(next + 10));
	return a_make(index);
});
verify(await callbackReplacedAsync(3), 3);
verify(await callbackReplacedAsync(4), 14);
immutable_callback_replace(null);
for (const run of [immutable_pair_many, pairManyAsync] as const) {
	const input: Array<[Immutable, Immutable]> = [
		[a_make(3), a_make(5)],
		[a_make(7), a_make(11)],
	];
	const output = await run(input);
	check(
		output.value.length === input.length &&
			output.value[1]![0].nested.writable === 109 &&
			input[1]![0].nested.writable === 9,
		"counted const array inout initializes every nested element",
	);
}
console.log("const results passed");
