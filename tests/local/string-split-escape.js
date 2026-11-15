function returnParts(value) {
	const parts = value.split("|");
	let total = 0;
	for (let index = 0; index < parts.length; index++) {
		const part = parts[index].trim();
		total += part.length;
	}
	return parts;
}

function throwParts(value) {
	const parts = value.split("|");
	let total = 0;
	for (let index = 0; index < parts.length; index++) {
		const part = parts[index].trim();
		total += part.length;
	}
	throw parts;
}

function carryTrimmed(value) {
	const parts = value.split("|");
	let total = 0;
	let last = "";
	for (let index = 0; index < parts.length; index++) {
		const part = parts[index].trim();
		total += part.length;
		last = part;
	}
	return last;
}

function chooseParts(value, flag) {
	const parts = value.split("|");
	let total = 0;
	for (let index = 0; index < parts.length; index++) {
		const part = parts[index].trim();
		total += part.length;
	}
	return flag ? parts : undefined;
}

const input = " first | second | last ";
const invoke = new Function("fn", "value", "flag", "return fn(value, flag);");
const returned = invoke(returnParts, input);
let thrown;
try {
	invoke(throwParts, input);
} catch (value) {
	thrown = value;
}
console.log(
	JSON.stringify([
		Array.isArray(returned),
		returned,
		Array.isArray(thrown),
		thrown,
		invoke(carryTrimmed, input),
		invoke(chooseParts, input, true),
		invoke(chooseParts, input, false),
		invoke(returnParts, input) !== returned,
	]),
);
