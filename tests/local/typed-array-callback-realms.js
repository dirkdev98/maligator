"use strict";
const gc = globalThis.__mal_collect_garbage;
const other = $262.createRealm().global;
const rows = [];
function map(values) {
	return values.map(function realmElement(value, index) {
		gc?.();
		rows.push([value, index, this === undefined, arguments.length]);
		if (value === 17) throw new RangeError("local callback");
		for (let i = 0; i < 2; i++) value += index;
		return value;
	});
}
for (const Ctor of [Int32Array, other.Int32Array]) {
	const mapped = map(new Ctor([2, 3, 4]));
	rows.push(mapped instanceof Ctor, Array.from(mapped));
	try {
		map(new Ctor([2, 17, 4]));
	} catch (error) {
		rows.push(error instanceof RangeError, error instanceof other.RangeError);
	}
	const invalid = new Ctor([1]);
	Object.defineProperty(invalid, "constructor", {
		value: { [Symbol.species]: () => {} },
	});
	try {
		map(invalid);
	} catch (error) {
		rows.push(error instanceof TypeError, error instanceof other.TypeError);
	}
}
const local = new Int32Array([5, 6]);
Object.defineProperty(local, "map", { value: other.Int32Array.prototype.map });
rows.push(Array.from(map(local)));
rows.push(Array.from(map(new Int32Array([3, 4]))));
console.log(JSON.stringify(rows));
