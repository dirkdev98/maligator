let checks = 0;
function equal(actual, expected, name) {
	checks++;
	if (!Object.is(actual, expected))
		throw new Error(name + ": " + actual + " != " + expected);
}
function read(collection, key) {
	return collection.get(key);
}
function contains(collection, value) {
	return collection.has(value);
}
function label(receiver) {
	return receiver.label();
}

class Counts extends Map {
	get(key) {
		return super.get(key) ?? 0;
	}
	bump(key) {
		this.set(key, this.get(key) + 1);
	}
}
const counts = new Counts();
for (let i = 0; i < 210; i++) counts.bump(i % 7);
let total = 0;
for (let round = 0; round < 50; round++) {
	for (let i = 0; i < 7; i++) total += read(counts, i);
}
equal(total, 50 * 210, "Map subclass method through a warm site");
equal(read(counts, 99), 0, "Map subclass default");
equal(read(new Map([[1, 5]]), 1), 5, "plain Map at the subclass site");
equal(read(counts, 1), 30, "subclass after plain Map");
counts.extra = true;
equal(read(counts, 2), 30, "receiver shape change");
counts.get = () => -1;
equal(read(counts, 1), -1, "own method shadows the class method");
delete counts.get;
equal(read(counts, 1), 30, "own method removed");
const original = Counts.prototype.get;
Counts.prototype.get = function (key) {
	return 1000 + Map.prototype.get.call(this, key);
};
equal(read(counts, 3), 1030, "class method replaced after warm-up");
Counts.prototype.get = original;
equal(read(counts, 3), 30, "class method restored");
const middle = Object.create(Counts.prototype, {
	get: { value: () => "middle", configurable: true },
});
Object.setPrototypeOf(counts, middle);
equal(read(counts, 3), "middle", "intermediate prototype method");
delete middle.get;
equal(read(counts, 3), 30, "intermediate method removed");
Object.setPrototypeOf(counts, Map.prototype);
equal(read(counts, 3), 30, "builtin prototype restored");
equal(read(counts, 99), undefined, "builtin get semantics");

const proxied = new Map([["a", 1]]);
Object.setPrototypeOf(
	proxied,
	new Proxy(Map.prototype, {
		get(target, key, receiver) {
			return key === "get" ? () => "proxied" : Reflect.get(target, key, receiver);
		},
	}),
);
let proxiedReads = "";
for (let i = 0; i < 3; i++) proxiedReads += read(proxied, "a");
equal(proxiedReads, "proxiedproxiedproxied", "unrecordable proxy chain");
Object.setPrototypeOf(proxied, Counts.prototype);
let recordable = 0;
for (let i = 0; i < 20; i++) recordable += read(proxied, i % 2 === 0 ? "a" : "b");
equal(recordable, 10, "chain becomes recordable");

class Tags extends Set {
	has(value) {
		return super.has(String(value));
	}
}
const tags = new Tags(["1", "2"]);
let hits = 0;
for (let i = 0; i < 40; i++) if (contains(tags, i % 4)) hits++;
equal(hits, 20, "Set subclass method");
Object.defineProperty(tags, "has", { value: () => false, configurable: true });
equal(contains(tags, 1), false, "Set own method shadow");
delete tags.has;
equal(contains(tags, 1), true, "Set own method removed");

class Day extends Date {
	label() {
		return this.getUTCDate();
	}
}
class Pattern extends RegExp {
	label() {
		return this.source;
	}
}
const day = new Day(Date.UTC(2020, 0, 9));
const pattern = new Pattern("ab+");
let labels = "";
for (let i = 0; i < 6; i++) labels += label(i % 2 === 0 ? day : pattern);
equal(labels, "9ab+9ab+9ab+", "Date and RegExp subclass methods at one site");
Day.prototype.label = () => "changed";
equal(label(day), "changed", "Date subclass method replaced");
function viewBytes(view) {
	return view.byteLength;
}
function bufferBytes(buffer) {
	return buffer.byteLength;
}
const bytes = new Uint8Array(12);
const backing = new ArrayBuffer(24);
let extents = 0;
for (let i = 0; i < 100; i++) extents += viewBytes(bytes) + bufferBytes(backing);
equal(extents, 100 * 36, "warm typed-array and ArrayBuffer byteLength sites");
console.log("INHERITED BUILTIN RECEIVER PASS " + checks);
