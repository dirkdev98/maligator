"use strict";

const gc = globalThis.__mal_collect_garbage;
if (typeof gc !== "function") {
	throw new Error("map-get-set-cache requires MAL_HOST_GC=1");
}

let passed = 0;
function check(name, condition) {
	if (!condition) throw new Error("FAIL " + name);
	passed++;
}

const direct = new Map([["key", { value: 1 }]]);
check("direct get", direct.get("key").value === 1);
check("direct cached has", direct.has("key") && !direct.has("missing"));
direct.set("key", { value: 2 });
check("direct cached update", direct.size === 1 && direct.get("key").value === 2);

const gcBoundaryKey = { boundary: true };
const gcBoundary = new Map([[gcBoundaryKey, 1]]);
check("GC boundary setup", gcBoundary.get(gcBoundaryKey) === 1);
gc();
gcBoundary.set(gcBoundaryKey, 2);
check(
	"GC boundary forces ordinary fallback",
	gcBoundary.size === 1 && gcBoundary.get(gcBoundaryKey) === 2,
);

const deleted = new Map([
	["first", 1],
	["second", 2],
]);
check("delete setup", deleted.get("first") === 1);
check("delete cached key", deleted.delete("first"));
deleted.set("first", 3);
check(
	"delete reinsert appends",
	deleted.size === 2 && Array.from(deleted.keys()).join(",") === "second,first",
);

const cleared = new Map([["old", 1]]);
check("clear setup", cleared.get("old") === 1);
cleared.clear();
cleared.set("old", 2);
check("clear invalidates", cleared.size === 1 && cleared.get("old") === 2);

const grown = new Map([["anchor", 1]]);
check("growth setup", grown.get("anchor") === 1);
for (let i = 0; i < 128; i++) grown.set("growth-" + i, i);
grown.set("anchor", 2);
check(
	"growth preserves handle",
	grown.size === 129 &&
		grown.get("anchor") === 2 &&
		grown.keys().next().value === "anchor",
);

const nanMap = new Map([[NaN, 1]]);
check("NaN setup", nanMap.get(Number("not-a-number")) === 1);
nanMap.set(NaN, 2);
check("NaN cached update", nanMap.size === 1 && nanMap.get(NaN) === 2);

const zeroMap = new Map([[-0, 1]]);
check("zero setup", zeroMap.get(0) === 1);
zeroMap.set(-0, 2);
const storedZero = zeroMap.keys().next().value;
check("negative zero cached update", zeroMap.size === 1 && 1 / storedZero === Infinity);

const firstString = ["equal", "string"].join(":");
const secondString = "xequal:string".slice(1);
const thirdString = "equal:string!".slice(0, -1);
const stringMap = new Map([[firstString, 1]]);
check("equal string setup", stringMap.get(secondString) === 1);
stringMap.set(thirdString, 2);
check(
	"equal string cached update",
	stringMap.size === 1 && stringMap.get(firstString) === 2,
);

const objectKey = { key: 1 };
const otherObject = { key: 1 };
const objectMap = new Map([[objectKey, 1]]);
check("object identity setup", objectMap.get(objectKey) === 1);
objectMap.set(objectKey, 2);
check(
	"object identity cached update",
	objectMap.size === 1 &&
		objectMap.get(otherObject) === undefined &&
		objectMap.get(objectKey) === 2,
);

const iterated = new Map([
	["first", 1],
	["second", 2],
]);
const iterator = iterated.entries();
check("iterator setup", iterator.next().value.join(":") === "first:1");
check("iterator cached key setup", iterated.get("second") === 2);
iterated.set("second", 3);
const iteratedSecond = iterator.next();
check(
	"cached update preserves iterator",
	iteratedSecond.value.join(":") === "second:3" && iterator.next().done,
);

const gcKey = { name: "key" };
const gcMap = new Map([[gcKey, { generation: 1 }]]);
gc();
check("GC fallback setup", gcMap.get(gcKey).generation === 1);
gc();
const replacement = { generation: 2, payload: new Array(64).fill("live") };
gcMap.set(gcKey, replacement);
gc();
check(
	"GC between get and set falls back",
	gcMap.size === 1 &&
		gcMap.get(gcKey) === replacement &&
		gcMap.get(gcKey).payload[63] === "live",
);

const weakKey = {};
const weak = new WeakMap([[weakKey, 1]]);
check("weak setup", weak.get(weakKey) === 1);
weak.set(weakKey, 2);
gc();
check("weak remains correct", weak.get(weakKey) === 2);

console.log("map-get-set-cache PASS " + passed + "/" + passed);
