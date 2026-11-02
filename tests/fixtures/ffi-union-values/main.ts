/* oxlint-disable no-console -- The fixture reports its public FFI result. */
import * as c from "maligator:ffi/unions";

function check(value: unknown, expected: unknown): void {
	if (value !== expected)
		throw new Error(`Expected ${String(expected)}, received ${String(value)}`);
}
function range(call: () => unknown): void {
	try {
		call();
	} catch (error) {
		if (error instanceof RangeError) return;
		throw error;
	}
	throw new Error("Expected a RangeError");
}
check(c.scalar_integer(-17), -17);
check(c.scalar_real(1.25), 1.25);
check(c.scalar_wide(0xffffffffffffffffn), 0xffffffffffffffffn);
range(() => c.scalar_wide(1n << 64n));
check(c.scalar_bits(7), 7);
range(() => c.scalar_bits(8));
check(c.scalar_items([2, 3, 5]).join(","), "2,3,5");
check(c.scalar_box({ value: 19, label: 23 }).value, 19);
check(c.scalar_update(1.25).value, 1.75);
check(c.scalar_out().value, 0xffffffffffffffffn);
check(c.scalar_many([2, 3, 5]), 10);
check(c.scalar_real_many([0.5, 1.25]), 1.75);
const arrays = c.scalar_arrays();
if (arrays === null) throw new Error("Missing union array result");
check(arrays.map((value) => value.join(",")).join(";"), "2,3,5;7,11,13");
let reads = 0;
const point = {
	get x() {
		reads++;
		const garbage = new Array(2048).fill("fictional");
		check(garbage.length, 2048);
		return 29;
	},
	y: 2.5,
	get integer() {
		throw new Error("An inactive union member was read");
	},
};
const copied = c.scalar_point(point);
check(copied.x, 29);
check(copied.y, 2.5);
check(reads, 1);
c.scalar_visit(copied, (value) => {
	check(value.x, 29);
	return value;
});
await c.scalar_visit_async(copied, (value) => {
	check(value.y, 2.5);
	return value;
});
check(await c.scalar_integer_async(31), 31);
function closed(read: () => unknown): void {
	try {
		read();
	} catch (error) {
		if (error instanceof TypeError) return;
		throw error;
	}
	throw new Error("A callback resource escaped its loan");
}
const saved: { resource?: c.Resource } = {};
function take(resource: c.Resource, expected: number): void {
	check(resource.value, expected);
	check(c.resource_read(resource), expected);
	saved.resource = resource;
}
function expired(): void {
	const resource = saved.resource;
	if (resource === undefined) throw new Error("Missing callback resource");
	closed(() => resource.value);
	closed(() => c.resource_read(resource));
}
c.resources_visit((values) => take(values[0], 41));
expired();
c.resources_record_visit((value) => take(value.resources[0], 43));
expired();
await c.resources_visit_async((values) => take(values[0], 41));
expired();
await c.resources_record_visit_async((value) => take(value.resources[0], 43));
expired();
const parent = c.resource_parent_new();
check(parent.version, 1);
check("payload" in parent, false);
parent[Symbol.dispose]();
console.log("union values passed");
