"use strict";

let passed = 0;
function check(name, condition) {
	if (!condition) throw new Error("FAIL " + name);
	passed++;
}

function dictionary(object) {
	Object.defineProperty(object, "dictionary", {
		get() {
			return 0;
		},
		configurable: true,
	});
	return object;
}

function read(object) {
	return object.target;
}

function indexed(object, key) {
	return object[key];
}

function write(object, value) {
	object.target = value;
}

function indexedWrite(object, key, value) {
	object[key] = value;
}

const object = dictionary({ target: 0 });
let sum = 0;
for (let index = 0; index < 512; index++) {
	object.target = index;
	sum += read(object);
}
check("cached reads observe current values", sum === 130816);
for (let index = 0; index < 128; index++) object["extra" + index] = index;
object.target = 513;
check("growth retains the current property", read(object) === 513);

const writeTarget = dictionary({ target: 0 });
for (let index = 0; index < 512; index++) write(writeTarget, index);
check("cached static writes update dictionary data", writeTarget.target === 511);
Object.defineProperty(writeTarget, "target", {
	value: 700,
	writable: true,
	enumerable: false,
	configurable: false,
});
write(writeTarget, 701);
check(
	"cached writes preserve non-enumerable non-configurable attributes",
	writeTarget.target === 701 && !Object.keys(writeTarget).includes("target"),
);
Object.preventExtensions(writeTarget);
write(writeTarget, 702);
check("non-extensible dictionaries retain writable updates", writeTarget.target === 702);

let setterReceiver;
let setterValue = 0;
const accessorWriteTarget = dictionary({ target: 0 });
for (let index = 0; index < 4; index++) write(accessorWriteTarget, index);
Object.defineProperty(accessorWriteTarget, "target", {
	configurable: true,
	get() {
		return setterValue;
	},
	set(value) {
		setterReceiver = this;
		setterValue = value;
	},
});
write(accessorWriteTarget, 703);
check(
	"data-to-accessor changes invoke the setter with the receiver",
	setterReceiver === accessorWriteTarget && setterValue === 703,
);

const computedWriteTarget = dictionary({ target: 0 });
let writeCoercions = 0;
const writeKey = {
	toString() {
		writeCoercions++;
		return "target";
	},
};
indexedWrite(computedWriteTarget, writeKey, 704);
check(
	"computed write keys are converted exactly once",
	computedWriteTarget.target === 704 && writeCoercions === 1,
);

const readonlyWriteTarget = dictionary({ target: 705 });
Object.defineProperty(readonlyWriteTarget, "target", { writable: false });
let readonlyThrew = false;
try {
	write(readonlyWriteTarget, 706);
} catch (error) {
	readonlyThrew = error instanceof TypeError;
}
check(
	"alternating receivers recheck write permissions",
	readonlyThrew && readonlyWriteTarget.target === 705,
);
write(computedWriteTarget, 707);
check(
	"writable receivers remain cacheable after a rejection",
	computedWriteTarget.target === 707,
);

const dictionaryPrototype = dictionary({ target: 708 });
const dictionaryChild = Object.create(dictionaryPrototype);
for (let index = 0; index < 16; index++) {
	check("warm inherited dictionary read", read(dictionaryChild) === 708);
}
write(dictionaryPrototype, 709);
check(
	"cached prototype writes invalidate inherited reads",
	read(dictionaryChild) === 709,
);

const reordered = dictionary({ first: -1, target: 17 });
check("another table can put the key at another index", read(reordered) === 17);
check("returning to the first layout revalidates the key", read(object) === 513);
const short = dictionary({ target: 19 });
const wide = dictionary({ a: 0, b: 0, c: 0, d: 0, target: 17 });
check("a shorter table rejects an out-of-range hint", read(wide) + read(short) === 36);

delete object.target;
object.other = 21;
check("a deleted entry cannot expose another key", read(object) === undefined);
object.target = 23;
check("reinsertion uses the new entry", read(object) === 23);
Object.defineProperty(object, "target", { value: 29, writable: false });
check("non-writable data properties remain readable", read(object) === 29);

let getterCalls = 0;
Object.defineProperty(object, "target", {
	get() {
		getterCalls++;
		return this.extra3 + getterCalls;
	},
	configurable: true,
});
check(
	"data-to-accessor changes invoke every getter",
	read(object) === 4 && read(object) === 5,
);
check("accessor receives the original receiver", getterCalls === 2);
Object.defineProperty(object, "target", { get: undefined });
check("an absent getter returns undefined", read(object) === undefined);
const failure = {};
Object.defineProperty(object, "target", {
	get() {
		throw failure;
	},
});
let caught;
try {
	read(object);
} catch (error) {
	caught = error;
}
check("getter exceptions escape the property load", caught === failure);

Object.defineProperty(object, "target", {
	get() {
		return read(reordered) + 1;
	},
});
check("a reentrant getter may replace the same cache row", read(object) === 18);
delete object.target;
Object.setPrototypeOf(object, {
	get target() {
		return this.extra5 + 31;
	},
});
check("an inherited getter retains the receiver", read(object) === 36);
Object.setPrototypeOf(object, null);
check(
	"a missing property on a null prototype returns undefined",
	read(object) === undefined,
);
Object.defineProperty(object, "target", {
	value: 37,
	writable: true,
	configurable: true,
});
check("new own data shadows the previous inherited property", read(object) === 37);

let proxyCalls = 0;
const proxy = new Proxy(object, {
	get(target, key, receiver) {
		proxyCalls++;
		return Reflect.get(target, key, receiver) + 1;
	},
});
check("a proxy receiver still invokes its trap", read(proxy) === 38 && proxyCalls === 1);
delete object.target;
const proxyPrototype = new Proxy(
	{},
	{
		get(_target, key, receiver) {
			return key === "target" ? receiver.extra7 + 41 : undefined;
		},
	},
);
Object.setPrototypeOf(object, proxyPrototype);
check("a proxy prototype sees the original receiver", read(object) === 48);

const other = dictionary({ target: 43, alternate: 47 });
check(
	"computed keys may change at the same site",
	indexed(other, "target") === 43 && indexed(other, "alternate") === 47,
);
let coercions = 0;
const key = {
	toString() {
		coercions++;
		return "target";
	},
};
check(
	"object keys are converted once per load",
	indexed(other, key) === 43 && coercions === 1,
);
check(
	"object keys are converted again on later loads",
	indexed(other, key) === 43 && coercions === 2,
);
check(
	"equal fresh strings resolve the same property",
	indexed(other, ["tar", "get"].join("")) === 43,
);
const symbol = Symbol("target");
other[symbol] = 53;
check("symbols do not collide with string hints", indexed(other, symbol) === 53);
other[1] = 59;
check(
	"numeric and string index keys retain ordinary semantics",
	indexed(other, 1) === 59 && indexed(other, "1") === 59,
);

const array = [61];
array.target = 67;
function callable() {}
callable.target = 71;
check(
	"array receivers preserve their own property behavior",
	read(other) + read(array) === 110,
);
check(
	"callable receivers preserve their own property behavior",
	read(other) + read(callable) === 114,
);
const shaped = { target: 73 };
check(
	"a site can return from dictionary to shaped storage",
	read(other) + read(shaped) === 116,
);
check("a site can return from shaped to dictionary storage", read(other) === 43);

const retained = dictionary({ target: { value: 79 } });
check("heap values warm the hint", read(retained).value === 79);
const collect = globalThis.__mal_collect_garbage ?? globalThis.gc;
if (typeof collect === "function") collect();
retained.target = { value: 83 };
check("a hint reads the new heap value after collection", read(retained).value === 83);
Object.freeze(retained);
check("freezing a dictionary preserves its current data", read(retained).value === 83);
console.log("own-table-property-cache PASS " + passed);
