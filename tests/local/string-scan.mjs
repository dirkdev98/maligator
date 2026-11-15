function copy(text) {
	if (typeof text !== "string") throw new TypeError("string required");
	let result = "";
	for (const character of text) {
		if (character === "!") throw new Error("sentinel");
		result += character;
	}
	return result;
}

function segments(text) {
	if (typeof text !== "string") throw new TypeError("string required");
	const parts = [];
	let result = "";
	let escaping = false;
	let state = "start";
	for (const character of text) {
		if (escaping) {
			result += character;
			escaping = false;
			continue;
		}
		if (character === "\\") {
			escaping = true;
			continue;
		}
		if (character === ".") {
			parts.push(result);
			result = "";
			continue;
		}
		if (state === "start") state = "property";
		result += character;
	}
	if (escaping) result += "\\";
	parts.push(result);
	return [parts, state];
}

function counted(text) {
	let result = "";
	let count = 0;
	for (const character of text) {
		count++;
		result += character;
	}
	return [result, count];
}

function reset(text) {
	let result = "";
	for (const character of text) {
		result = "";
		result += character;
	}
	return result;
}

const inputs = JSON.parse(
	'["", "a", "plain", "caf\u00e9", "a\\u0000b", "a.b", "a\\\\.b", "a\\\\", "wide\u20ac", "astral\ud83d\ude00", "\\ud800x\\udc00"]',
);
inputs.push("x".repeat(127), "x".repeat(128), "x".repeat(129), "x".repeat(300));
const output = {
	copies: inputs.map((text) => [text, copy(text)]),
	segments: inputs.map((text) => [text, segments(text)]),
	counts: inputs.map((text) => counted(text)),
	resets: inputs.map((text) => reset(text)),
	errors: [],
	iterators: [],
};
try {
	copy("before!after");
} catch (error) {
	output.errors.push(error.message);
}

const original = String.prototype[Symbol.iterator];
let steps = 0;
String.prototype[Symbol.iterator] = function () {
	let index = 0;
	return {
		next() {
			steps++;
			return index++ === 0 ? { value: "replacement", done: false } : { done: true };
		},
	};
};
output.iterators.push([copy("plain"), steps]);
String.prototype[Symbol.iterator] = original;
output.iterators.push([copy("restored")]);
const prototype = Object.getPrototypeOf(original.call(""));
const next = prototype.next;
steps = 0;
prototype.next = function () {
	steps++;
	const result = next.call(this);
	return result.done ? result : { value: "mapped", done: false };
};
output.iterators.push([copy("abc"), steps]);
prototype.next = next;
output.iterators.push([copy("restored-again")]);
console.log(JSON.stringify(output));
