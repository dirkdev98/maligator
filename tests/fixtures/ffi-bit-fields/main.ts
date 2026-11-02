/* oxlint-disable no-console -- The fixture reports its public FFI result. */
import {
	fields_copy,
	fields_copy_async,
	fields_packed,
	fields_box,
	fields_visit,
	fields_state,
	fields_configure,
	FlagState,
} from "maligator:ffi/fields";

function check(value: unknown, expected: unknown): void {
	if (value !== expected)
		throw new Error(`Expected ${String(expected)}, received ${String(value)}`);
}
function range(call: () => void): void {
	try {
		call();
	} catch (error) {
		if (error instanceof RangeError) return;
		throw error;
	}
	throw new Error("Expected a RangeError");
}
const flags = {
	small: 7,
	offset: -16,
	narrow: 127,
	wide: (1n << 33n) - 1n,
	balance: -(1n << 39n),
	enabled: true,
	mode: 7,
	inline_mode: 7,
};
function same(value: typeof flags): void {
	for (const key of Object.keys(flags) as Array<keyof typeof flags>)
		check(value[key], flags[key]);
}
same(fields_copy(flags));
same(fields_box({ flags, version: 15 }).flags);
check(fields_packed({ first: 7, second: (1 << 21) - 1 }).second, (1 << 21) - 1);
fields_visit(flags, (value) => {
	same(value);
	return value;
});
for (const [key, value] of [
	["small", 8],
	["mode", 8],
	["mode", -1],
	["inline_mode", 8],
	["inline_mode", -1],
	["offset", -17],
	["offset", 16],
	["narrow", 128],
	["wide", 1n << 33n],
	["wide", -1n],
	["balance", 1n << 39n],
	["balance", -(1n << 39n) - 1n],
] as const)
	range(() => fields_copy({ ...flags, [key]: value }));
let reads = 0;
same(
	fields_copy({
		...flags,
		get wide() {
			reads++;
			const garbage = new Array(2048).fill("fictional");
			check(garbage.length, 2048);
			return flags.wide;
		},
	}),
);
check(reads, 1);
const state = FlagState();
fields_configure(state, 7, (1n << 33n) - 1n);
check(fields_state(state), (1n << 33n) + 6n);
check(state.mode, 7);
check(state.count, (1n << 33n) - 1n);
state[Symbol.dispose]();
same(await fields_copy_async(flags));
console.log("bit-fields passed");
