"use strict";

function backward(values) {
	let result;
	for (let round = 0; round < 3; round++) {
		const trace = [];
		result = values.reduceRight((text, value, index, receiver) => {
			trace.push([index, value, receiver === values]);
			return text + value;
		}, "");
		result = [result, trace];
	}
	return result;
}
function seedless(values) {
	let left;
	let right;
	for (let round = 0; round < 3; round++) {
		left = values.reduce((sum, value) => sum - value);
		right = values.reduceRight((sum, value) => sum - value);
	}
	return [left, right];
}
function last(values) {
	let result;
	for (let round = 0; round < 3; round++) {
		const trace = [];
		const value = values.findLast((value, index) => {
			trace.push([index, value]);
			return value === undefined;
		});
		const index = values.findLastIndex((value) => value === undefined);
		result = [value, index, trace];
	}
	return result;
}
function mapped(values) {
	let result;
	for (let round = 0; round < 3; round++) {
		const trace = [];
		const flattened = values.flatMap((value, index, receiver) => {
			trace.push([index, receiver === values]);
			return value === 2 ? [, value, [value + 1]] : value;
		});
		result = [flattened, trace];
	}
	return result;
}
function flattened(input) {
	return [
		[input].flat().find((value) => value === "stop"),
		[input].flat().findIndex((value) => value === "stop"),
	];
}
function snapshot(input) {
	return [input].flat().find((value, index) => {
		input[1] = "changed";
		return index === 1;
	});
}
function explicitUndefined(values) {
	let result;
	for (let round = 0; round < 3; round++)
		result = values.reduceRight((sum, value) => value, undefined);
	return result;
}
const results = [
	backward([1, , 3, 4]),
	seedless([, 7, , 3, 1]),
	last([1, , 3]),
	mapped([1, , 2, 4]),
];
results.push(snapshot(["first", "stop"]), explicitUndefined([]), explicitUndefined([1]));
for (const values of [[], new Array(3)]) {
	try {
		seedless(values);
	} catch (error) {
		results.push(error.name);
	}
}
for (const value of ["stop", "miss", [], ["first", , "stop"], [, "stop"]])
	results.push(flattened(value));
const proxyTrace = [];
results.push(
	mapped([
		new Proxy([4, , 6], {
			has(target, key) {
				proxyTrace.push("has:" + String(key));
				return Reflect.has(target, key);
			},
			get(target, key, receiver) {
				proxyTrace.push("get:" + String(key));
				return Reflect.get(target, key, receiver);
			},
		}),
	]),
);
results.push(proxyTrace);
class Custom extends Array {}
results.push(mapped(Custom.from([1, 2])));
console.log(JSON.stringify(results));
