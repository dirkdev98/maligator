"use strict";
const gc = globalThis.__mal_collect_garbage ?? globalThis.gc;
const other = $262.createRealm().global;
const rows = [];
function realmCompare(a, b) {
	gc?.();
	if (a === 9n || b === 9n) throw new RangeError("local comparator");
	return a < b ? -1 : a > b ? 1 : 0;
}
function sort(input) {
	return input.sort(realmCompare);
}
function copy(input) {
	return input.toSorted(realmCompare);
}
for (const Ctor of [BigInt64Array, other.BigInt64Array]) {
	const input = new Ctor([3n, 1n, 2n]);
	const output = copy(input);
	rows.push(
		output.join(","),
		output instanceof Ctor,
		input.join(","),
		sort(input) === input,
	);
	for (const copyOnly of [false, true]) {
		try {
			const invalid = new Ctor([9n, 1n]);
			if (copyOnly) copy(invalid);
			else sort(invalid);
		} catch (error) {
			rows.push(
				error.message,
				error instanceof RangeError,
				error instanceof other.RangeError,
			);
		}
	}
}
const foreign = new other.BigInt64Array([3n, 1n, 2n]);
Object.defineProperty(foreign, "sort", { value: BigInt64Array.prototype.sort });
rows.push(sort(foreign).join(","));
const local = new BigInt64Array([3n, 1n, 2n]);
Object.defineProperty(local, "toSorted", {
	value: other.BigInt64Array.prototype.toSorted,
});
const foreignCopy = copy(local);
rows.push(foreignCopy.join(","), foreignCopy instanceof other.BigInt64Array);
rows.push(copy(new BigInt64Array([4n, 2n, 3n])).join(","));
console.log(JSON.stringify(rows));
