/* oxlint-disable no-console -- The fixture reports observable scalar ABI behavior. */
import {
	scalar_at,
	scalar_calls,
	scalar_dot,
	scalar_empty,
	scalar_float,
	scalar_float32,
	scalar_high,
	scalar_i32,
	scalar_last,
	scalar_nan,
	scalar_not,
	scalar_scale,
	scalar_sum_u8,
	scalar_touch,
	scalar_u32,
	scalar_u64,
	scalar_u8,
} from "maligator:ffi/scalar";
import { checkNamespaceCalls } from "./namespace.ts";

function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}
function refuses(action: () => void, kind: typeof TypeError | typeof RangeError): void {
	let caught = false;
	try {
		action();
	} catch (error) {
		caught = error instanceof kind;
	}
	check(caught, "invalid scalar conversion retains its exception");
}
let sum = 0;
const callsBeforeLoop = scalar_calls();
for (let index = 0; index < 512; index++) sum += scalar_i32(index | 0);
check(
	sum === (511 * 512) / 2 && scalar_calls() === callsBeforeLoop + 512n,
	"proven scalar loop keeps every C call",
);
check(scalar_u32(4294967295) === 4294967295, "unsigned boundary remains exact");
check(scalar_u8(255) === 255, "narrow unsigned boundary remains exact");
const before = scalar_calls();
refuses(() => scalar_u32(-1), RangeError);
refuses(() => scalar_i32(2147483648), RangeError);
refuses(() => scalar_u8(256), RangeError);
refuses(() => scalar_u8(0.5), RangeError);
refuses(() => scalar_i32("1" as unknown as number), TypeError);
refuses(() => (scalar_i32 as unknown as () => number)(), TypeError);
let coerced = 0;
refuses(
	() =>
		scalar_i32({
			valueOf() {
				coerced++;
				return 7;
			},
		} as unknown as number),
	TypeError,
);
check(
	coerced === 0 && scalar_calls() === before,
	"rejected arguments neither coerce nor enter C",
);
let extra = 0;
const extraValue = {
	get value() {
		extra++;
		return 9;
	},
};
check(
	(scalar_i32 as unknown as (...values: Array<unknown>) => number)(
		7,
		extraValue.value,
	) === 7 && extra === 1,
	"extra argument effects precede scalar calls",
);
check(
	scalar_not(true) === false && scalar_not(false) === true,
	"native booleans keep their exact brand",
);
refuses(() => scalar_not(1 as unknown as boolean), TypeError);
check(Object.is(scalar_float(-0), -0), "typed floating calls preserve negative zero");
check(
	scalar_float32(16777217) === 16777216,
	"float parameters round through their C width",
);

const result = new Float64Array(1);
result[0] = scalar_nan();
check(
	new DataView(result.buffer).getUint32(4, true) === 0x7ff80000,
	"floating results canonicalize NaN before native storage",
);
const input = new Float64Array(1);
new DataView(input.buffer).setBigUint64(0, 0xfff8123400000042n, true);
check(
	scalar_high(input[0]!) === 0x7ff80000,
	"floating arguments canonicalize NaN before C",
);
check(
	scalar_high(scalar_nan()) === 0x7ff80000,
	"native floating chains preserve boundary canonicalization",
);
scalar_touch(19);
check(scalar_last() === 19, "void scalar calls preserve C state");
const first = scalar_u64(9007199254740993n);
const second = scalar_u64(first + 1n);
check(
	first === 9007199254740993n && second === 9007199254740994n,
	"wide boxed values remain immutable snapshots",
);
check(
	scalar_u64(18446744073709551615n) === 18446744073709551615n,
	"wide unsigned results keep their full precision",
);
refuses(() => scalar_u64(-1n), RangeError);

const left = new Float64Array([1, 2, 3, 4]);
const right = new Float64Array([5, 6, 7, 8]);
const callsBeforeViews = scalar_calls();
let dot = 0;
for (let index = 0; index < 64; index++) dot += scalar_dot(left, right);
check(
	dot === 64 * 70 && scalar_calls() === callsBeforeViews + 64n,
	"lent views reach every C call",
);
check(scalar_dot([1, 2], [3, 4]) === 11, "arrays still convert by copy");
check(
	scalar_dot(left.subarray(1), right.subarray(1)) === 2 * 6 + 3 * 7 + 4 * 8,
	"offset views lend their own elements",
);
const callsBeforeRejection = scalar_calls();
refuses(() => scalar_dot(left, right.subarray(1)), TypeError);
refuses(
	() => scalar_dot(new Float32Array(4) as unknown as Float64Array, right),
	TypeError,
);
const detached = new Float64Array(4);
detached.buffer.transfer();
refuses(() => scalar_dot(detached, right), TypeError);
check(scalar_calls() === callsBeforeRejection, "rejected views never enter C");
const resizable = new Float64Array(new ArrayBuffer(32, { maxByteLength: 64 }), 0, 4);
resizable.fill(1);
check(scalar_dot(resizable, right) === 26, "views of resizable buffers still convert");
check(scalar_empty(new Float64Array(0)), "empty views pass C a null pointer");
const scaled = new Float64Array([1, 2, 3]);
scalar_scale(scaled, 2);
check(scaled.join() === "2,4,6", "writable views receive C's writes");
const frozen = new Float64Array(
	(
		new Float64Array([1, 2]).buffer as ArrayBuffer & {
			transferToImmutable(): ArrayBuffer;
		}
	).transferToImmutable(),
);
refuses(() => scalar_scale(frozen, 2), TypeError);
check(frozen.join() === "1,2", "immutable views refuse C writes");
check(
	scalar_sum_u8(new Uint8Array([1, 2, 250])) === 253 &&
		scalar_sum_u8(Buffer.from([4, 5])) === 9,
	"unsigned counts carry byte view lengths",
);
function dotLoop(
	a: ReadonlyArray<number> | Float64Array,
	b: ReadonlyArray<number> | Float64Array,
	count: number,
): number {
	let total = 0;
	for (let index = 0; index < count; index++) total += scalar_dot(a, b);
	return total;
}
function weightedLoop(weights: Float64Array, count: number): number {
	let total = 0;
	for (let index = 0; index < count; index++)
		total += weights[index]! * scalar_dot(left, right);
	return total;
}
function indexLoop(values: Float64Array): number {
	let total = 0;
	for (let index = 0; index < 4; index++) total += scalar_at(values, index);
	return total;
}
function scaleLoop(values: Float64Array, count: number): void {
	for (let index = 0; index < count; index++) scalar_scale(values, 0.5);
}
const callsBeforeLoops = scalar_calls();
check(
	dotLoop(left, right, 100) === 100 * 70 && scalar_calls() === callsBeforeLoops + 100n,
	"a loop lending views calls C once per iteration",
);
check(dotLoop([1, 2], [3, 4], 3) === 33, "a loop over arrays still copies them");
const callsBeforeMismatch = scalar_calls();
refuses(() => dotLoop(left, right.subarray(1), 3), TypeError);
check(scalar_calls() === callsBeforeMismatch, "a loop never lends mismatched views");
check(
	weightedLoop(new Float64Array([1, 2, 3]), 3) === 6 * 70,
	"element reads and lent views share one loop",
);
check(
	Number.isNaN(weightedLoop(new Float64Array([1]), 2)),
	"a loop past its elements keeps reading undefined",
);
const callsBeforeIndexLoop = scalar_calls();
check(
	indexLoop(new Float64Array([1, 2, 4, 8, 16])) === 15 &&
		indexLoop(new Float64Array([1, 2])) === 1 &&
		scalar_calls() === callsBeforeIndexLoop + 8n,
	"a loop passes its counter to an integer parameter",
);
const halves = new Float64Array([8, 16]);
scaleLoop(halves, 3);
check(halves.join() === "1,2", "a loop's writable views see each call's writes");
checkNamespaceCalls();
console.log("scalar ABI passed");
