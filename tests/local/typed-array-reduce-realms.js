"use strict";
const gc = globalThis.__mal_collect_garbage;
const other = $262.createRealm().global;
const rows = [];

function reduce(values, right = false) {
	const callback = function realmReducer(acc, value, index) {
		gc?.();
		rows.push([index, this === undefined]);
		if (value === 17) throw new RangeError("local callback");
		for (let i = 0; i < 2; i++) acc += value;
		return acc;
	};
	return right ? values.reduceRight(callback) : values.reduce(callback);
}

for (const right of [false, true]) {
	rows.push(reduce(new other.Int32Array([2, 3, 4]), right));
	const values = new Int32Array([2, 3, 4]);
	Object.defineProperties(values, {
		reduce: { value: other.Int32Array.prototype.reduce },
		reduceRight: { value: other.Int32Array.prototype.reduceRight },
	});
	rows.push(reduce(values, right));
	try {
		reduce(new other.Int32Array(0), right);
	} catch (error) {
		rows.push(error instanceof other.TypeError, error instanceof TypeError);
	}
	try {
		reduce(new other.Int32Array([2, 17, 4]), right);
	} catch (error) {
		rows.push(error instanceof other.RangeError, error instanceof RangeError);
	}
	try {
		reduce(new Int32Array(0), right);
	} catch (error) {
		rows.push(error instanceof other.TypeError, error instanceof TypeError);
	}
	rows.push(reduce(new Int32Array([2, 3]), right));
}
console.log(JSON.stringify(rows));
