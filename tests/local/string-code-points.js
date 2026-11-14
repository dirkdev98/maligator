const rows = [];
const gc = globalThis.__mal_collect_garbage ?? globalThis.gc;

function scan(text, observe = false) {
	if (typeof text !== "string") throw new TypeError("string required");
	let value = "";
	let escaped = false;
	let state = "start";
	let count = 0;
	const parts = [];
	for (const character of text) {
		count++;
		if (escaped) {
			value += character;
			escaped = false;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (observe) {
			gc?.();
			parts.push(character);
		}
		switch (character) {
			case ".":
				parts.push(value);
				value = "";
				state = "property";
				break;
			case "[":
				value += character;
				state = "index";
			case "]":
				value += character;
				break;
			default:
				if (state === "start") state = "property";
				value += character;
		}
	}
	if (escaped) value += "\\";
	parts.push(value, state, count);
	return parts;
}

for (const text of [
	"",
	"name",
	"meta.score",
	"tags[2].label",
	"a\\.b.c\\",
	"a😀.b\\😀",
	"é.€",
	"\ud800x.\udc00",
	"x".repeat(127) + "😀.tail",
	"prefix".repeat(40) + ".suffix",
]) {
	rows.push(scan(text), scan(("prefix" + text).slice(6)), scan(text, true));
}

function classify(text) {
	if (typeof text !== "string") throw new TypeError("string required");
	let value = "";
	for (const character of text) {
		switch (character) {
			case "\ud83d":
				value += "lead";
				break;
			case "\ude00":
				value += "trail";
				break;
			case "€":
				value += "wide";
				break;
			default:
				value += character;
		}
	}
	return value;
}
rows.push(classify("x😀x\ud83dx\ude00x€"));

const originalIterator = String.prototype[Symbol.iterator];
const iteratorPrototype = Object.getPrototypeOf(originalIterator.call(""));
const originalNext = iteratorPrototype.next;
function closeAfterMutation(text) {
	if (typeof text !== "string") throw new TypeError("string required");
	let value = "";
	for (const character of text) {
		value += character;
		iteratorPrototype.return = function () {
			closed++;
			return {};
		};
		iteratorPrototype.next = () => {
			throw new Error("cached next was replaced");
		};
		if (character === ".") break;
	}
	return value;
}
let closed = 0;
try {
	rows.push(closeAfterMutation("a.b"), closed);
} finally {
	iteratorPrototype.next = originalNext;
	delete iteratorPrototype.return;
}

let iteratorCalls = 0;
String.prototype[Symbol.iterator] = function () {
	iteratorCalls++;
	return ["x", "😀", "\\", ".", 2, { toString: () => "object" }][Symbol.iterator]();
};
try {
	rows.push(scan("patched"), iteratorCalls);
} finally {
	String.prototype[Symbol.iterator] = originalIterator;
}

let nextCalls = 0;
iteratorPrototype.next = function () {
	nextCalls++;
	const result = originalNext.call(this);
	if (!result.done && result.value === "a") result.value = "😀";
	return result;
};
try {
	rows.push(scan("a.b"), nextCalls);
} finally {
	iteratorPrototype.next = originalNext;
}

console.log(JSON.stringify(rows));
