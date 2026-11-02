/* oxlint-disable no-console -- The fixture reports observable C behavior. */
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import {
	effects_mix,
	effects_length,
	effects_wide,
	effects_signed,
	effects_touch,
	effects_point,
	effects_points,
	effects_new,
	effects_tick,
} from "maligator:ffi/math";
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
	check(caught, "invalid input must preserve its exception");
}
setFlagsFromString("--expose-gc");
const collect = runInNewContext("gc") as () => void;
check(effects_length("alpine") === 6n, "literal string allocation reaches C");
const wideCases: ReadonlyArray<readonly [bigint, number]> = [
	[0n, 0],
	[9007199254740993n, 9007199254740992],
	[9223372036854775807n, 9223372036854775808],
	[18446744073709551615n, 18446744073709551616],
];
for (const [value, rounded] of wideCases) {
	let last = 0n;
	let total = 0;
	for (let index = 0; index < 16; index++) {
		last = effects_wide(value);
		total += Number(last);
	}
	check(
		last === value && effects_wide(last) === value,
		"foreign BigInts stay exact after Number conversion",
	);
	check(total === rounded * 16, "foreign BigInt Number rounding");
}
const signed = effects_signed(-9223372036854775808n);
check(
	signed === -9223372036854775808n && Number(signed) === -9223372036854775808,
	"signed foreign BigInt boundary",
);
let sum = 0;
for (let index = 0; index < 2048; index++) sum = (sum + effects_mix(index)) >>> 0;
let expected = 0;
for (let index = 0; index < 2048; index++) {
	const value = (Math.imul(index, 1664525) + 1013904223) >>> 0;
	expected = (expected + value) >>> 0;
}
check(sum === expected, "module numeric state survives pure C calls");
let numericOnly = 0;
for (let index = 0; index < 2048; index++)
	numericOnly = (numericOnly + effects_mix(index)) >>> 0;
check(numericOnly === expected, "evaluator-only numeric state preserves uint32 wrapping");
let negativeZero = -0;
negativeZero += effects_mix(0) * 0;
check(Object.is(negativeZero, 0), "numeric state preserves negative zero addition");
let mutable: number | { valueOf(): number } = 1;
let objectCoercions = 0;
effects_point({
	get x() {
		mutable = {
			valueOf() {
				objectCoercions++;
				collect();
				return 19;
			},
		};
		return 0;
	},
	y: 0,
});
check(
	(mutable as number) + effects_mix(0) === 19 + 1013904223 && objectCoercions === 1,
	"callback writers preserve object coercion of module state",
);
let beforeInitialization = false;
try {
	effects_point({
		get x() {
			return later;
		},
		y: 0,
	});
} catch (error) {
	beforeInitialization = error instanceof ReferenceError;
}
const later = 7;
check(beforeInitialization && later === 7, "callback reads preserve the module TDZ");
const beforeThrow = sum;
refuses(() => {
	sum = effects_mix(-1);
}, RangeError);
check(sum === beforeThrow, "throwing conversions preserve prior module state");
refuses(() => {
	(effects_mix as unknown as (...values: Array<unknown>) => number)();
}, TypeError);
let extraCalls = 0;
const extra = {
	get value() {
		extraCalls++;
		return 9;
	},
};
check(
	(effects_mix as unknown as (...values: Array<unknown>) => number)(7, extra.value) ===
		effects_mix(7),
	"extra arguments preserve C arity",
);
check(extraCalls === 1, "extra argument getters still run");
let coercions = 0;
refuses(() => {
	effects_mix({
		valueOf() {
			coercions++;
			return 1;
		},
	} as unknown as number);
}, TypeError);
check(coercions === 0, "exact numeric conversion never invokes user coercion");
refuses(() => effects_mix("invalid" as unknown as number), TypeError);

const dynamic = new Uint8Array([1, 2, 3]);
check(dynamic[0] === 1, "initial dynamic byte");
effects_touch(dynamic);
check(Number(dynamic[0]) === 42, "C invalidates numeric element reads");
const named = new Uint8Array([3, 4]);
check(named["0"] === 3, "initial named byte");
effects_touch(named);
check(Number(named["0"]) === 42, "C invalidates named numeric property reads");

let getterState = 3;
check(
	effects_point({
		get x() {
			getterState = 41;
			collect();
			return 2;
		},
		y: 5,
	}) === 7,
	"record getters feed C",
);
check(getterState === 41, "record getters invalidate module state");
let proxyState = 0;
const points = new Proxy(
	[
		{ x: 1, y: 2 },
		{ x: 3, y: 4 },
	],
	{
		get(target, key, receiver) {
			if (key === "0") proxyState = 17;
			return Reflect.get(target, key, receiver) as unknown;
		},
	},
);
check(
	effects_points(points) === 10 && proxyState === 17,
	"array Proxy conversion remains observable",
);
let getterThrew = false;
try {
	effects_point({
		get x(): number {
			getterState = 99;
			throw new Error("getter failed");
		},
		y: 1,
	});
} catch (error) {
	getterThrew = error instanceof Error && error.message === "getter failed";
}
check(
	getterThrew && Number(getterState) === 99,
	"getter exceptions preserve their writes",
);
let fields = 0;
for (let index = 0; index < 64; index++) {
	const point = effects_new(index);
	fields += point.x + point.y;
}
check(fields === 64 * 64, "C record results survive GC and storage reuse");
const firstTick = effects_tick();
check(effects_tick() === firstTick + 1, "host state effects preserve repeated C calls");
console.log("foreign effects passed");
