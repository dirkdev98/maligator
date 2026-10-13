"use strict";

const gc = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});
const mode = globalThis.process?.env?.EXACT_CALLBACK_KIND ?? "all";
let growths = 0;
function growFunctionTable() {
	let source = "return [";
	for (let index = 0; index < 64; index++)
		source += (index ? "," : "") + "function(){return " + (index + growths) + ";}";
	source += "];";
	const functions = Function(source)();
	if (functions[63]() !== 63 + growths) throw new Error("runtime compilation result");
	growths++;
	gc();
}

const marker = { reason: "callback" };
function boxedMap(values) {
	let calls = 0;
	const result = values.map(function growingBoxed(value, index, receiver) {
		calls++;
		if (this !== 17 || receiver !== values || arguments.length !== 3)
			throw new Error("boxed callback arguments");
		if (index === 0) growFunctionTable();
		if (value === 99) throw marker;
		gc();
		return [value, index, calls].join(":");
	}, 17);
	return result.join(",");
}

function numericReduce(values) {
	let factor = 1;
	return values.reduce(function growingReducer(accumulator, value, index, receiver) {
		if (this !== undefined || receiver !== values || arguments.length !== 4)
			throw new Error("reducer arguments");
		if (index === 0) growFunctionTable();
		if (index === 1) {
			const nested = [3, 4].reduce((left, right) => left + right, 0);
			if (nested !== 7) throw new Error("nested reduction");
			growFunctionTable();
		}
		factor++;
		gc();
		for (let step = 0; step < 2; step++) accumulator += value * factor;
		return +accumulator;
	}, 0);
}

function numericSort(values) {
	let calls = 0;
	let factor = 1;
	const result = values.sort(function growingComparator(left, right) {
		if (this !== undefined || arguments.length !== 2)
			throw new Error("comparator arguments");
		calls++;
		if (calls === 1) {
			growFunctionTable();
			factor = 2;
		}
		if (calls === 2) {
			const nested = new Int32Array([3, 1, 2]).sort((a, b) => b - a);
			if (nested.join(",") !== "3,2,1") throw new Error("nested sort");
			growFunctionTable();
		}
		gc();
		return (left - right) * factor;
	});
	if (calls < 3) throw new Error("insufficient comparisons");
	return result.join(",");
}

if (mode === "all" || mode === "boxed") {
	class SpeciesArray extends Array {
		static get [Symbol.species]() {
			growFunctionTable();
			return Array;
		}
	}
	console.log("boxed", boxedMap(new SpeciesArray(3, 1, 2)));
	let caught;
	try {
		boxedMap([99, 1]);
	} catch (error) {
		caught = error;
	}
	if (caught !== marker) throw new Error("callback throw identity");
	console.log("recovered", boxedMap([4, 5]));
}
if (mode === "all" || mode === "reduce") {
	console.log("reduce", numericReduce([1, 2, 3]));
	console.log("typed-reduce", numericReduce(new Float64Array([1, 2, 3])));
}
if (mode === "all" || mode === "sort") {
	console.log("sort", numericSort([5, 1, 4, 2, 3]));
	console.log("typed-sort", numericSort(new Float64Array([5, 1, 4, 2, 3])));
}
console.log("growths", growths);
