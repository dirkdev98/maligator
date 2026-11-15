function parameterWrite(value) {
	value = 9;
	return arguments[0];
}

function argumentWrite(value) {
	arguments[0] = 12;
	return value;
}

function deleted(value) {
	delete arguments[0];
	value = 20;
	const missing = arguments[0];
	arguments[0] = 30;
	return [missing, value, arguments[0]];
}

function defaultParameter(value = 4) {
	value = 9;
	const original = arguments[0];
	arguments[0] = 12;
	return [original, value];
}

function restParameter(value, ...rest) {
	value = 9;
	const original = arguments[0];
	arguments[0] = 12;
	return [original, value, rest];
}

function destructuredParameter({ value }) {
	value = 9;
	const original = arguments[0].value;
	arguments[0] = { value: 12 };
	return [original, value];
}

function strictParameter(value) {
	"use strict";
	value = 9;
	const original = arguments[0];
	arguments[0] = 12;
	return [original, value];
}

function mutate(values) {
	values[0] = { name: "birch" };
	return values;
}

function passed(value) {
	const values = arguments;
	value = { name: "cedar" };
	const before = values[0].name;
	const same = mutate(values) === arguments;
	return [before, value.name, same];
}

function defaultRead(key = 0, value) {
	value = 9;
	return arguments[key];
}

function restRead(key, value, ...rest) {
	value = 9;
	return [arguments[key], rest];
}

function destructuredRead(key, { value }) {
	value = 9;
	return arguments[key];
}

const cases = {
	parameterWrite: () => parameterWrite(1),
	argumentWrite: () => argumentWrite(1),
	deleteUnmaps: () => deleted(1),
	defaults: () => [defaultParameter(1), defaultParameter()],
	rest: () => restParameter(1, 2, 3),
	destructuring: () => destructuredParameter({ value: 1 }),
	strict: () => strictParameter(1),
	passed: () => passed({ name: "ash" }),
	nonSimpleReads: () => [
		defaultRead(1, 3),
		restRead(1, 3, 5),
		destructuredRead(1, { value: 3 }),
	],
};

for (const [name, run] of Object.entries(cases)) {
	console.log(`${name}:${JSON.stringify(run())}`);
}
