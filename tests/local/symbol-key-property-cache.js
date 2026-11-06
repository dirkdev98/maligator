"use strict";

// Well-known symbol keys reach computed loads as `Symbol.dispose` expressions and
// through variables. Their site caches must keep serving own and inherited methods
// across a loop and observe every mutation that changes the answer.
const results = [];
const disposeKey = Symbol.dispose;

class Resource {
	[Symbol.dispose]() {
		return 1;
	}
}
class Other {
	[Symbol.dispose]() {
		return 3;
	}
}
const own = {
	[Symbol.dispose]() {
		return 2;
	},
};
const resources = Array.from({ length: 256 }, () => new Resource());
let checksum = 0;
for (let round = 0; round < 64; round++) {
	for (const resource of resources) checksum += resource[Symbol.dispose]();
	checksum += own[disposeKey]();
}
results.push(["cached symbol methods", checksum === 64 * (256 * 1 + 2)]);
let alternating = 0;
for (const resource of [new Resource(), new Other(), own, new Other()]) {
	alternating += resource[Symbol.dispose]();
}
results.push(["alternating receivers", alternating === 1 + 3 + 2 + 3]);

function disposeOf(value) {
	return value[Symbol.dispose];
}
function read(value, key) {
	return value[key];
}

const original = Resource.prototype[Symbol.dispose];
const resource = new Resource();
disposeOf(resource);
const replaced = () => 4;
Resource.prototype[Symbol.dispose] = replaced;
results.push(["prototype method replacement", disposeOf(resource) === replaced]);
const shadow = () => 5;
resource[Symbol.dispose] = shadow;
results.push(["own shadowing", disposeOf(resource) === shadow]);
delete resource[Symbol.dispose];
results.push(["own deletion", disposeOf(resource) === replaced]);
Object.setPrototypeOf(resource, Other.prototype);
results.push([
	"prototype change",
	disposeOf(resource) === Other.prototype[Symbol.dispose],
]);
Resource.prototype[Symbol.dispose] = original;

const plain = {};
const missingBefore = disposeOf(plain) === undefined && disposeOf(plain) === undefined;
const added = () => 6;
Object.prototype[Symbol.dispose] = added;
const addedSeen = disposeOf(plain) === added;
delete Object.prototype[Symbol.dispose];
results.push([
	"missing then inherited",
	missingBefore && addedSeen && disposeOf(plain) === undefined,
]);

let getterCalls = 0;
const accessor = Object.create(
	Object.defineProperty({}, Symbol.dispose, {
		get() {
			getterCalls++;
			return replaced;
		},
	}),
);
const accessorReads = [disposeOf(accessor), disposeOf(accessor), disposeOf(accessor)];
results.push([
	"inherited accessor runs per read",
	accessorReads.every((value) => value === replaced) && getterCalls === 3,
]);

const unique = Symbol("key");
const lookalike = Symbol("key");
results.push([
	"unique symbol keys",
	read({ [unique]: 7 }, unique) === 7 && read({ [unique]: 7 }, lookalike) === undefined,
]);
results.push([
	"exotic and primitive receivers",
	read([], Symbol.iterator) === Array.prototype.values &&
		read("text", Symbol.iterator) === String.prototype[Symbol.iterator] &&
		read(new Map(), Symbol.iterator) === Map.prototype.entries,
]);
const trapped = [];
const proxy = new Proxy(
	{},
	{
		get(_target, key) {
			trapped.push(key);
			return 8;
		},
	},
);
results.push([
	"proxy receivers",
	disposeOf(proxy) === 8 && disposeOf(proxy) === 8 && trapped.length === 2,
]);

let passed = 0;
for (const [name, ok] of results) {
	if (ok) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
