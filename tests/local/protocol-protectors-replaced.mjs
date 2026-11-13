// After an unrelated polyfill, replaces each piece of the Array, String and
// generator iteration protocols, between warm loops and from inside one, and
// restores it. Each protocol's loops must observe only their own replacements.
const results = [];
function record(label, value) {
	results.push(`${label}=${value}`);
}

Object.defineProperty(Array.prototype, "myHelper", {
	value() {
		return this.length;
	},
	writable: true,
	configurable: true,
});
String.prototype.myHelper = function () {
	return this.length;
};

const ArrayPrototype = Array.prototype;
const ArrayIteratorPrototype = Object.getPrototypeOf([][Symbol.iterator]());
const StringIteratorPrototype = Object.getPrototypeOf(""[Symbol.iterator]());
const GeneratorPrototype = Object.getPrototypeOf(function* () {}).prototype;
const IteratorPrototype = Object.getPrototypeOf(ArrayIteratorPrototype);
const original = {
	arrayIterator: ArrayPrototype[Symbol.iterator],
	arrayNext: ArrayIteratorPrototype.next,
	stringIterator: String.prototype[Symbol.iterator],
	stringNext: StringIteratorPrototype.next,
	generatorNext: GeneratorPrototype.next,
	generatorReturn: GeneratorPrototype.return,
};
const log = [];

function sumArray(values, stop) {
	let total = 0;
	for (const value of values) {
		total += value;
		if (value === stop) break;
	}
	return total;
}

function sumString(text, stop) {
	let total = 0;
	for (const character of text) {
		total += character.codePointAt(0) & 15;
		if (character === stop) break;
	}
	return total;
}

function* sequence(seed) {
	for (let index = 0; index < 5; index++) yield seed + index;
}

function sumSequence(seed, stop) {
	let total = 0;
	for (const value of sequence(seed | 0)) {
		total += value;
		if (value === stop) break;
	}
	return total;
}

function sumRest(stop, ...values) {
	let total = 0;
	for (const value of values) {
		total += value;
		if (value === stop) break;
	}
	return total;
}

function add(a, b, c) {
	return a + b * 2 + c * 3;
}

function pair(values) {
	const [first, second] = values;
	return `${first}:${second}`;
}

// Every protocol once, both to completion and through a break.
function round(label) {
	const numbers = [1, 2, 3, 4, 5];
	const parts = [
		sumArray(numbers, -1),
		sumArray(numbers, 3),
		sumString("abcde", ""),
		sumString("abcde", "c"),
		sumSequence(2, -1),
		sumSequence(2, 4),
		sumRest(-1, 1, 2, 3, 4),
		sumRest(2, 1, 2, 3, 4),
		add(...[1, 2, 3]),
		pair(numbers),
		[..."xyz"].join(""),
	];
	record(label, parts.join(","));
	record(`${label}.log`, log.splice(0).join(" "));
}

function warm() {
	let total = 0;
	for (let index = 0; index < 64; index++) {
		total += sumArray([index, 1, 2], -1) + sumString("warm", "") + sumSequence(index, -1);
		total += sumRest(-1, index, 2) + add(...[index, 1, 2]);
	}
	return total;
}

record("warm", warm());
round("intact");

ArrayPrototype[Symbol.iterator] = function () {
	log.push("array@@iterator");
	return original.arrayIterator.call(this);
};
round("arrayIterator");
ArrayPrototype[Symbol.iterator] = original.arrayIterator;
round("arrayIterator.restored");

ArrayIteratorPrototype.next = function () {
	const step = original.arrayNext.call(this);
	return step.done ? step : { value: step.value * 10, done: false };
};
round("arrayNext");
ArrayIteratorPrototype.next = original.arrayNext;

// A loop that started with the realm's own `next` keeps it; the replaced one
// applies from the next loop on.
record(
	"arrayNext.inside",
	sumArray(
		{
			[Symbol.iterator]() {
				return [1, 2, 3][Symbol.iterator]();
			},
		},
		-1,
	),
);
let insideTotal = 0;
for (const value of [1, 2, 3, 4]) {
	if (value === 2) {
		ArrayIteratorPrototype.next = function () {
			log.push("arrayNext");
			return original.arrayNext.call(this);
		};
	}
	insideTotal += value;
}
record("arrayNext.inside.total", insideTotal);
round("arrayNext.after");
ArrayIteratorPrototype.next = original.arrayNext;

String.prototype[Symbol.iterator] = function () {
	log.push("string@@iterator");
	return original.stringIterator.call(this);
};
round("stringIterator");
String.prototype[Symbol.iterator] = original.stringIterator;

StringIteratorPrototype.next = function () {
	const step = original.stringNext.call(this);
	return step.done ? step : { value: step.value.toUpperCase(), done: false };
};
round("stringNext");
StringIteratorPrototype.next = original.stringNext;

GeneratorPrototype.next = function () {
	const step = original.generatorNext.call(this);
	return step.done ? step : { value: step.value * 100, done: false };
};
round("generatorNext");
GeneratorPrototype.next = original.generatorNext;

GeneratorPrototype.return = function (value) {
	log.push("generatorReturn");
	return original.generatorReturn.call(this, value);
};
round("generatorReturn");
GeneratorPrototype.return = original.generatorReturn;

// A `return` on the shared tails reaches every protocol whose iterator lacks one.
IteratorPrototype.return = function (value) {
	log.push(
		`return:${Object.getPrototypeOf(this) === GeneratorPrototype ? "?" : typeof this}`,
	);
	return { value, done: true };
};
round("iteratorReturn");
delete IteratorPrototype.return;
round("iteratorReturn.deleted");

Object.defineProperty(Object.prototype, "return", {
	configurable: true,
	get() {
		log.push("objectReturn");
		return undefined;
	},
});
round("objectReturn");
delete Object.prototype.return;

// Breaking out after the loop body adds a `return`.
let closing = 0;
for (const value of [1, 2, 3]) {
	if (value === 2) {
		ArrayIteratorPrototype.return = function () {
			closing++;
			return {};
		};
		break;
	}
}
for (const character of "abc") {
	if (character === "b") {
		StringIteratorPrototype.return = function () {
			closing += 10;
			return {};
		};
		break;
	}
}
record("closing", closing);
delete ArrayIteratorPrototype.return;
delete StringIteratorPrototype.return;

const closer = {
	return() {
		log.push("reparentedReturn");
		return {};
	},
};
Object.setPrototypeOf(closer, IteratorPrototype);
Object.setPrototypeOf(ArrayIteratorPrototype, closer);
round("arrayReparented");
Object.setPrototypeOf(ArrayIteratorPrototype, IteratorPrototype);
Object.setPrototypeOf(StringIteratorPrototype, closer);
round("stringReparented");
Object.setPrototypeOf(StringIteratorPrototype, IteratorPrototype);
const iterating = {
	[Symbol.iterator]() {
		log.push("generator@@iterator");
		return this;
	},
};
Object.setPrototypeOf(iterating, IteratorPrototype);
Object.setPrototypeOf(GeneratorPrototype, iterating);
round("generatorReparented");
Object.setPrototypeOf(GeneratorPrototype, IteratorPrototype);
round("final");
record("warm.final", warm());

console.log(results.join("\n"));
