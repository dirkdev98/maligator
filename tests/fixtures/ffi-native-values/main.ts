/* oxlint-disable no-console -- The fixture reports observable native value behavior. */
import {
	NativeUnsigned,
	NativeExtended,
	NATIVE_MAX,
	NATIVE_ONE,
	native_unsigned_make,
	makeUnsignedAsync,
	native_other_make,
	native_unsigned_high,
	native_unsigned_low,
	native_alias,
	native_unsigned_add,
	native_calls,
	native_signed_min,
	signedMinAsync,
	native_signed_is_min,
	native_precise,
	preciseAsync,
	native_is_precise,
	native_record,
	recordAsync,
	native_record_check,
	checkRecordAsync,
	native_const_record,
	constRecordAsync,
	native_const_record_check,
	checkConstRecordAsync,
	native_choice,
	choiceAsync,
	native_choice_check,
	checkChoiceAsync,
	native_unsigned_out,
	unsignedOutAsync,
	native_unsigned_inout,
	unsignedInoutAsync,
	native_unsigned_sum,
	sumUnsignedAsync,
	native_unsigned_array,
	arrayUnsignedAsync,
	native_with_callback,
	native_callback,
	callbackAsync,
	parallelAsync,
	native_notify,
	getUnsignedGlobal,
	setUnsignedGlobal,
	getConstUnsigned,
	getConstValues,
} from "maligator:ffi/native_values";
function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}
function maximum(value: NativeUnsigned): boolean {
	return (
		native_unsigned_high(value) === 0xffffffffffffffffn &&
		native_unsigned_low(value) === 0xffffffffffffffffn
	);
}
const zero = NativeUnsigned();
check(
	native_unsigned_high(zero) === 0n && native_unsigned_low(zero) === 0n,
	"native factories construct arithmetic zero",
);
check(maximum(NATIVE_MAX), "typed constants keep the full unsigned 128-bit range");
check(
	Object.prototype.toString.call(NativeExtended()) === "[object NativeExtended]",
	"native boxes retain their type identity",
);
for (const run of [native_unsigned_make, makeUnsignedAsync]) {
	const value = await run(0xffffffffffffffffn, 0xffffffffffffffffn);
	check(
		maximum(value) && maximum(native_alias(value)),
		"typedef aliases preserve every unsigned bit",
	);
}
const max = native_unsigned_make(0xffffffffffffffffn, 0xffffffffffffffffn);
const disposable = native_unsigned_make(0xffffffffffffffffn, 0xffffffffffffffffn);
const independent = sumUnsignedAsync([disposable]);
disposable[Symbol.dispose]();
check(maximum(await independent), "workers own native values before source disposal");
const callbackSource = native_unsigned_make(0xffffffffffffffffn, 0xffffffffffffffffn);
check(
	maximum(
		native_with_callback(callbackSource, () => {
			callbackSource[Symbol.dispose]();
		}),
	),
	"callbacks can dispose independent source boxes",
);

check(
	native_unsigned_low(native_unsigned_add(max, native_unsigned_make(0n, 1n))) === 0n,
	"native unsigned arithmetic follows C wrapping",
);
for (const run of [native_signed_min, signedMinAsync])
	check(
		native_signed_is_min(await run()) === 1,
		"signed 128-bit minima round-trip exactly",
	);
for (const run of [native_precise, preciseAsync])
	check(
		native_is_precise(await run()) === 1,
		"native floating precision stays outside Number conversion",
	);
check(
	native_is_precise(NATIVE_ONE) === 0,
	"typed floating constants remain native values",
);
for (const run of [native_record, recordAsync]) {
	const value = await run();
	check(
		native_record_check(value) === 1 && (await checkRecordAsync(value)) === 1,
		"records transport exact native fields",
	);
}
for (const run of [native_const_record, constRecordAsync]) {
	const value = await run();
	check(
		native_const_record_check(value) === 1 && (await checkConstRecordAsync(value)) === 1,
		"const record constructors retain native fields",
	);
}
for (const run of [native_choice, choiceAsync]) {
	const value = await run();
	check(
		native_choice_check(value) === 1 && (await checkChoiceAsync(value)) === 1,
		"selected union values preserve native payloads",
	);
}
for (const run of [native_unsigned_out, unsignedOutAsync])
	check(maximum((await run()).value), "native out values retain unsigned extremes");
for (const run of [native_unsigned_inout, unsignedInoutAsync]) {
	const value = (await run(max)).value;
	check(
		native_unsigned_high(value) === 0n &&
			native_unsigned_low(value) === 0n &&
			maximum(max),
		"native inout results are independent copies",
	);
}
for (const run of [native_unsigned_sum, sumUnsignedAsync]) {
	check(maximum(await run([max, zero])), "native arrays preserve element precision");
}
for (const run of [native_unsigned_array, arrayUnsignedAsync]) {
	const values = await run(2n);
	check(
		values !== null &&
			maximum(values[0]!) &&
			native_unsigned_high(values[1]!) === 1n << 36n,
		"C-owned arrays copy their native elements before release",
	);
}
setUnsignedGlobal(max);
check(
	maximum(getUnsignedGlobal()) && maximum(getConstUnsigned()),
	"mutable and const globals retain their opted typedef",
);
const constants = getConstValues();
check(
	maximum(constants[0]) && native_unsigned_high(constants[1]) === 1n << 36n,
	"const global arrays preserve native element aliases",
);
let captured: NativeUnsigned | undefined;
check(
	maximum(
		native_callback((value) => {
			captured = value;
			return value;
		}),
	),
	"synchronous callbacks return exact native values",
);
check(
	captured !== undefined && maximum(captured),
	"native callback arguments survive their invocation",
);
check(
	maximum(await callbackAsync((value) => value)),
	"worker callbacks retain native return precision",
);
check(
	(await parallelAsync((value) => {
		captured = value;
		return value;
	})) === 1,
	"waiting foreign callbacks preserve native results",
);
check(
	captured !== undefined && maximum(captured),
	"waiting callback value copies remain usable afterward",
);
await new Promise<void>((resolve) => {
	native_notify((value) => {
		captured = value;
		resolve();
	});
});
check(
	captured !== undefined && maximum(captured),
	"queued notifications produce independent native values",
);
for (const invalid of [native_other_make(), 1n, {}]) {
	const before = native_calls();
	let rejected = false;
	try {
		native_unsigned_add(invalid as NativeUnsigned, zero);
	} catch (error) {
		rejected = error instanceof TypeError;
	}
	check(
		rejected && native_calls() === before,
		"native inputs reject other brands and implicit scalar conversion",
	);
}
const closed = NativeUnsigned();
closed[Symbol.dispose]();
let disposed = false;
try {
	native_unsigned_add(closed, zero);
} catch (error) {
	disposed = error instanceof TypeError;
}
check(disposed, "disposed native boxes cannot be passed back to C");
zero[Symbol.dispose]();
console.log("native values passed");
