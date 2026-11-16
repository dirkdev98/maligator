function observe(fn) {
	try {
		return fn();
	} catch (error) {
		return error.name;
	}
}
function shared() {
	let value = 1;
	const thrown = {};
	let sameThrow = false;
	try {
		eval("value = 2; throw thrown");
	} catch (error) {
		sameThrow = error === thrown;
	}
	const afterThrow = value;
	const read = eval("() => value");
	const write = eval("next => value = next");
	value = 3;
	const afterCallerWrite = read();
	write(4);
	const afterEvalWrite = value;
	return {
		read,
		write,
		before: [sameThrow, afterThrow, afterCallerWrite, afterEvalWrite],
	};
}
function lexical() {
	const results = [];
	results.push(eval("0"));
	results.push(observe(() => eval("typeof later")));
	results.push(observe(() => eval("later = 2")));
	const read = eval("() => later");
	let later = 5;
	results.push(read());
	const fixed = 7;
	results.push(observe(() => eval("fixed = 8")));
	results.push(fixed, eval("delete later"));
	return results;
}
function argumentBinding(first) {
	const original = arguments;
	const read = eval("() => arguments");
	const write = eval("next => arguments = next");
	arguments = { marker: 3 };
	const followsCaller = read() === arguments;
	const replacement = { marker: 5 };
	write(replacement);
	const followsEval = arguments === replacement;
	try {
		eval("arguments = { marker: 9 }; throw 1");
	} catch {}
	return [followsCaller, followsEval, arguments.marker, original[0], first];
}
function nestedDeclarativeBindings() {
	let value = 1;
	const fixed = { marker: 7 };
	const thrown = {};
	const receiver = function () {
		"use strict";
		return this;
	};
	const result = [];
	result.push(eval("eval('value + fixed.marker')"));
	let sameThrow = false;
	try {
		eval("eval('value = 2; throw thrown')");
	} catch (error) {
		sameThrow = error === thrown;
	}
	result.push(sameThrow, value);
	const read = eval("eval('() => value')");
	value = { marker: 9 };
	result.push(read() === value);
	const write = eval("eval('next => value = next')");
	write(fixed);
	result.push(value === fixed);
	result.push(observe(() => eval("eval('typeof later')")));
	let later = 5;
	result.push(eval("eval('later')"));
	result.push(observe(() => eval("eval('fixed = 8')")));
	result.push(eval("let value = 19; eval('value')"));
	result.push(eval("eval('receiver() === undefined')"));
	result.push(eval("eval('delete value')"));
	result.push(eval(`eval('eval("later")')`));
	return result;
}
const sharedState = shared();
sharedState.write({ marker: 9 });
const reads = [];
for (let index = 0; index < 3; index++) reads.push(eval("() => index"));
const varReads = [];
for (var index = 0; index < 3; index++) varReads.push(eval("() => index"));
const named = function self() {
	return eval("self = 9; typeof self");
};
console.log(
	JSON.stringify([
		sharedState.before,
		sharedState.read(),
		lexical(),
		reads.map((read) => read()),
		varReads.map((read) => read()),
		named(),
		argumentBinding(7),
		nestedDeclarativeBindings(),
	]),
);
