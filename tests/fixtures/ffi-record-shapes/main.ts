/* oxlint-disable no-console -- The fixture reports its public FFI result. */
import {
	shapes_copy,
	shapes_copy_async,
	shapes_update,
	shapes_visit,
	shapes_total,
	shapes_configure,
	ShapeState,
	shapes_const_copy,
	shapes_const_promoted,
} from "maligator:ffi/records";
import type { ShapeEnvelope } from "maligator:ffi/records";

function check(value: unknown, expected: unknown): void {
	if (value !== expected)
		throw new Error(`Expected ${String(expected)}, received ${String(value)}`);
}
check(shapes_const_copy({ detail: { value: 41 } }).detail.value, 41);
check(shapes_const_promoted({ value: 43 }).value, 43);
const input: ShapeEnvelope = {
	version: 2,
	x: 11,
	y: -13,
	mode: 7,
	serial: (1n << 35n) - 1n,
	detail: { weight: 1.5, code: 17 },
	items: [{ value: 19 }, { value: 23 }],
};
function same(value: ShapeEnvelope): void {
	check(value.version, input.version);
	check(value.x, input.x);
	check(value.y, input.y);
	check(value.mode, input.mode);
	check(value.serial, input.serial);
	check(value.detail.weight, input.detail.weight);
	check(value.detail.code, input.detail.code);
	check(value.items[1].value, input.items[1].value);
	check(Object.keys(value).join(","), Object.keys(input).join(","));
}
same(shapes_copy(input));
shapes_visit(input, (value) => {
	same(value);
	return value;
});
check(shapes_total([input, input]), 22);
const updated = shapes_update(input).value;
check(updated.x, 12);
check(updated.detail.code, 18);
check(input.x, 11);
let reads = 0;
same(
	shapes_copy({
		...input,
		get detail() {
			reads++;
			const garbage = new Array(2048).fill("fictional");
			check(garbage.length, 2048);
			return input.detail;
		},
	}),
);
check(reads, 1);
for (const mode of [-1, 8]) {
	let rejected = false;
	try {
		shapes_copy({ ...input, mode });
	} catch (error) {
		if (!(error instanceof RangeError)) throw error;
		rejected = true;
	}
	check(rejected, true);
}
const state = ShapeState();
shapes_configure(state, 7, 2.5);
check(state.generation, 7);
check(state.weight, 2.5);
state[Symbol.dispose]();
same(await shapes_copy_async(input));
console.log("record shapes passed");
