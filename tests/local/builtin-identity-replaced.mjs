// After an unrelated polyfill, replaces, deletes and shadows the built-in methods
// that compiled builtin identities rely on, before warm loops and from inside one,
// and restores them. Every loop must observe exactly the current methods.
const results = [];
function record(label, value) {
	results[results.length] = `${label}=${value}`;
}

Object.defineProperty(String.prototype, "capitalize", {
	value() {
		return this.charAt(0).toUpperCase() + this.slice(1);
	},
	writable: true,
	configurable: true,
});
Map.prototype.getOr = function (key, fallback) {
	return this.has(key) ? this.get(key) : fallback;
};
Object.prototype.__polyfilled = true;
Math.clamp = (value, low, high) => Math.min(Math.max(value, low), high);

const StringPrototype = String.prototype;
const ArrayIteratorPrototype = Object.getPrototypeOf([][Symbol.iterator]());
const MapIteratorPrototype = Object.getPrototypeOf(new Map()[Symbol.iterator]());
const RegExpStringIteratorPrototype = Object.getPrototypeOf(/a/g[Symbol.matchAll]("a"));
const original = {
	charCodeAt: StringPrototype.charCodeAt,
	split: StringPrototype.split,
	exec: RegExp.prototype.exec,
	matchAll: RegExp.prototype[Symbol.matchAll],
	regexpIteratorNext: RegExpStringIteratorPrototype.next,
	mapIterator: Map.prototype[Symbol.iterator],
	mapNext: MapIteratorPrototype.next,
	arrayIterator: Array.prototype[Symbol.iterator],
	mapGet: Map.prototype.get,
	setHas: Set.prototype.has,
	push: Array.prototype.push,
	floor: Math.floor,
};
const log = [];

function charCodes(text, hook) {
	let total = 0;
	for (let index = 0; index < text.length; index++) {
		if (hook !== undefined) hook(index);
		total = (total + text.charCodeAt(index)) | 0;
	}
	return total;
}

function splitFields(line, hook) {
	let total = 0;
	for (let round = 0; round < 4; round++) {
		if (hook !== undefined) hook(round);
		for (const field of line.split(",")) total += field.trim().length;
	}
	return total;
}

function execCaptures(lines, pattern, hook) {
	let total = 0;
	for (let index = 0; index < lines.length; index++) {
		if (hook !== undefined) hook(index);
		const match = pattern.exec(lines[index]);
		if (match !== null) total += match[1].length + match[2].length;
	}
	return total;
}

function matchAllCaptures(text, hook) {
	let total = 0;
	let index = 0;
	for (const match of text.matchAll(/(\d+)-(\w+)/g)) {
		if (hook !== undefined) hook(index++);
		total += match[1].length + match[2].length;
	}
	return total;
}

function mapEntries(map, hook) {
	let total = 0;
	let index = 0;
	for (const [key, value] of map) {
		if (hook !== undefined) hook(index++);
		total += key.length + value;
	}
	return total;
}

function lookups(map, set, keys, hook) {
	let total = 0;
	for (let index = 0; index < keys.length; index++) {
		if (hook !== undefined) hook(index);
		if (set.has(keys[index])) total += map.get(keys[index]);
	}
	return total;
}

function floors(values, hook) {
	let total = 0;
	for (let index = 0; index < values.length; index++) {
		if (hook !== undefined) hook(index);
		total += Math.floor(values[index]);
	}
	return total;
}

const text = "scanner input";
const line = " alpha, beta ,gamma";
const lines = ["a1=bb", "c22=d", "no match", "eee333=ffff"];
const pattern = /([a-z]+)\d*=(\w+)/;
const pairs = "1-a 22-bb 333-ccc";
const map = new Map([
	["one", 1],
	["two", 2],
	["three", 3],
]);
const set = new Set(["one", "three"]);
const keys = ["one", "two", "three"];
const values = [1.5, 2.5, -3.5, 4.25];

function warm() {
	return [
		charCodes(text),
		splitFields(line),
		execCaptures(lines, pattern),
		matchAllCaptures(pairs),
		mapEntries(map),
		lookups(map, set, keys),
		floors(values),
	].join(",");
}

const loops = 50;
let intact = "";
for (let round = 0; round < loops; round++) intact = warm();
record("intact", intact);

// charCodeAt: replaced before a loop, from inside one, deleted so that the lookup
// reaches a method on Object.prototype, and shadowed by a String subclass.
StringPrototype.charCodeAt = function (index) {
	log.push(`charCodeAt(${index})`);
	return 1;
};
record("charCodeAt.replaced", charCodes(text));
StringPrototype.charCodeAt = original.charCodeAt;
record("charCodeAt.restored", charCodes(text));
record(
	"charCodeAt.mid",
	charCodes(text, (index) => {
		if (index === 5) StringPrototype.charCodeAt = () => 1000;
	}),
);
StringPrototype.charCodeAt = original.charCodeAt;
delete StringPrototype.charCodeAt;
Object.prototype.charCodeAt = function () {
	return typeof this === "object" ? 7 : -7;
};
record("charCodeAt.object-prototype", charCodes(text));
delete Object.prototype.charCodeAt;
let missing = "";
try {
	charCodes(text);
} catch (error) {
	missing = error.constructor.name;
}
record("charCodeAt.deleted", missing);
StringPrototype.charCodeAt = original.charCodeAt;
class Text extends String {}
Text.prototype.charCodeAt = () => 3;
record("charCodeAt.subclass", charCodes(new Text(text)));
record("charCodeAt.after", charCodes(text));

// split: replaced on String.prototype and from inside a loop.
StringPrototype.split = function (separator) {
	return original.split.call(this, separator).slice(1);
};
record("split.replaced", splitFields(line));
StringPrototype.split = original.split;
record(
	"split.mid",
	splitFields(line, (round) => {
		if (round === 2) StringPrototype.split = () => ["xy"];
	}),
);
StringPrototype.split = original.split;
record("split.after", splitFields(line));

// RegExp exec and matchAll: the methods, the iterator's next, and a mid-loop exec.
RegExp.prototype.exec = function (input) {
	log.push(`exec(${input})`);
	return original.exec.call(this, input);
};
record("exec.replaced", execCaptures(lines, pattern));
RegExp.prototype.exec = original.exec;
record(
	"exec.mid",
	execCaptures(lines, pattern, (index) => {
		if (index === 1) RegExp.prototype.exec = () => ["xx", "yyy", "zz"];
	}),
);
let execCalls = 0;
RegExp.prototype.exec = () => (execCalls++ < 2 ? ["7-x", "7", "x"] : null);
record("matchAll.exec-replaced", matchAllCaptures(pairs));
RegExp.prototype.exec = original.exec;
RegExp.prototype[Symbol.matchAll] = function (input) {
	log.push(`matchAll(${input})`);
	return original.matchAll.call(this, input);
};
record("matchAll.replaced", matchAllCaptures(pairs));
RegExp.prototype[Symbol.matchAll] = original.matchAll;
RegExpStringIteratorPrototype.next = function () {
	const step = original.regexpIteratorNext.call(this);
	return step.done ? step : { done: false, value: ["9-q", "9", "q"] };
};
record("matchAll.next-replaced", matchAllCaptures(pairs));
RegExpStringIteratorPrototype.next = original.regexpIteratorNext;
record("matchAll.after", matchAllCaptures(pairs));

// Map entries destructured into pairs: the Map protocol, the Array protocol the
// destructuring uses, a `return` the destructuring must call, and a subclass.
Map.prototype[Symbol.iterator] = function* () {
	yield ["replaced", 100];
};
record("entries.map-iterator", mapEntries(map));
Map.prototype[Symbol.iterator] = original.mapIterator;
MapIteratorPrototype.next = function () {
	const step = original.mapNext.call(this);
	return step.done ? step : { done: false, value: [step.value[0], step.value[1] * 10] };
};
record("entries.map-next", mapEntries(map));
MapIteratorPrototype.next = original.mapNext;
ArrayIteratorPrototype.return = function () {
	log.push("pair-return");
	return {};
};
record("entries.pair-return", mapEntries(map));
delete ArrayIteratorPrototype.return;
Array.prototype[Symbol.iterator] = function* () {
	yield "ab";
	yield 1000;
};
record("entries.pair-iterator", mapEntries(map));
Array.prototype[Symbol.iterator] = original.arrayIterator;
record(
	"entries.mid",
	mapEntries(map, (index) => {
		if (index === 0) {
			ArrayIteratorPrototype.return = function () {
				log.push("mid-pair-return");
				return {};
			};
		}
	}),
);
delete ArrayIteratorPrototype.return;
class Ordered extends Map {
	*[Symbol.iterator]() {
		yield ["ordered", 5];
	}
}
record("entries.subclass", mapEntries(new Ordered(map)));
record("entries.after", mapEntries(map));

// Map get and Set has, replaced before and inside a loop.
Map.prototype.get = function (key) {
	return key.length * 100;
};
record("lookups.get-replaced", lookups(map, set, keys));
Map.prototype.get = original.mapGet;
record(
	"lookups.mid",
	lookups(map, set, keys, (index) => {
		if (index === 1) Set.prototype.has = () => true;
	}),
);
Set.prototype.has = original.setHas;
record("lookups.after", lookups(map, set, keys));

// Math.floor through a mutable namespace, replaced before and inside a loop.
Math.floor = (value) => value * 10;
record("floor.replaced", floors(values));
Math.floor = original.floor;
record(
	"floor.mid",
	floors(values, (index) => {
		if (index === 2) Math.floor = Math.ceil;
	}),
);
Math.floor = original.floor;
record("floor.after", floors(values));

// Runtime fast paths: push, concat's spreadable hook, species, and Error names.
Array.prototype.push = function (value) {
	log[log.length] = `push(${value})`;
	return original.push.call(this, value, value);
};
const pushed = [];
pushed.push(1);
record("push.replaced", pushed.join());
Array.prototype.push = original.push;
Array.prototype[Symbol.isConcatSpreadable] = false;
record("concat.spreadable", JSON.stringify([1, 2].concat([3], 4)));
delete Array.prototype[Symbol.isConcatSpreadable];
record("concat.after", JSON.stringify([1, 2].concat([3], 4)));
class Sub extends Array {}
Array.prototype.constructor = Sub;
record("species.replaced", [1, 2].map((value) => value).constructor.name);
Array.prototype.constructor = Array;
record("species.after", [1, 2].map((value) => value).constructor.name);
TypeError.prototype.name = "CustomTypeError";
RangeError.prototype.message = "default range";
record("error.replaced", `${String(new TypeError("m"))}|${String(new RangeError())}`);
TypeError.prototype.name = "TypeError";
RangeError.prototype.message = "";
record("error.after", `${String(new TypeError("m"))}|${String(new RangeError())}`);

// A thenable hook on Object.prototype reaches every promise resolution value.
Object.prototype.then = function (resolve) {
	delete Object.prototype.then;
	resolve("thenable");
};
record("then", await Promise.resolve(1).then(() => ({})));

for (let round = 0; round < loops; round++) intact = warm();
record("restored", intact);
record("log", log.join(" "));
record("loops", loops);

console.log(results.join("\n"));
