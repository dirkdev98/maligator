function readWrite(seed) {
	"use strict";
	let local = seed;
	const result = eval("var hidden = 7; local += hidden; local");
	return [local, result, typeof hidden, typeof this];
}

function mapped(value) {
	value = 9;
	return arguments[0];
}

function sumRanges(count) {
	function* sequence(seed) {
		for (let index = 0; index < 6; index++) yield seed + index;
	}
	let sum = 0;
	for (let index = 0; index < count; index++)
		for (const value of sequence(index)) sum += value;
	return sum;
}

console.log(JSON.stringify([readWrite(3), mapped(1), sumRanges(20)]));
