/* oxlint-disable no-console -- The fixture reports observable scalar ABI behavior. */
import {
	scalar_calls,
	scalar_float,
	scalar_float32,
	scalar_high,
	scalar_i32,
	scalar_last,
	scalar_nan,
	scalar_not,
	scalar_touch,
	scalar_u32,
	scalar_u64,
	scalar_u8,
} from "maligator:ffi/scalar";

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
for (let index = 0; index < 512; index++) sum += scalar_i32(index | 0);
check(
	sum === (511 * 512) / 2 && scalar_calls() === 512n,
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
console.log("scalar ABI passed");
