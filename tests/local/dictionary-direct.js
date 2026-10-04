"use strict";

// Dynamic string keys on dictionary-mode objects may bypass per-site caches.
// Every observable [[Get]]/[[Set]] rule below must survive that shortcut.
const results = [];
function check(name, ok) {
	results.push([name, ok]);
}

const keys = Array.from({ length: 96 }, (_, index) => "dictionary-key-" + index);
function fill(target) {
	for (let index = 0; index < keys.length; index++) target[keys[index]] = index;
	return target;
}
function read(target, key) {
	return target[key];
}
function write(target, key, value) {
	target[key] = value;
}

const dictionary = fill(Object.create(null));
let sum = 0;
for (let round = 0; round < 64; round++) {
	for (let index = 0; index < keys.length; index++) {
		write(dictionary, keys[index], read(dictionary, keys[index]) + 1);
	}
}
for (const key of keys) sum += read(dictionary, key);
check("dictionary read/write totals", sum === 96 * 64 + (95 * 96) / 2);
check("missing dictionary key", read(dictionary, "absent") === undefined);

const accessorLog = [];
Object.defineProperty(dictionary, "computed", {
	get() {
		accessorLog.push(this === dictionary ? "get" : "wrong-get");
		return 7;
	},
	set(value) {
		accessorLog.push(this === dictionary ? "set:" + value : "wrong-set");
	},
	configurable: true,
});
check("accessor getter", read(dictionary, "computed") === 7);
write(dictionary, "computed", 9);
check("accessor setter receiver", accessorLog.join(",") === "get,set:9");

Object.defineProperty(dictionary, "fixed", {
	value: 1,
	writable: false,
	configurable: true,
});
let readonlyThrew = false;
try {
	write(dictionary, "fixed", 2);
} catch (error) {
	readonlyThrew = error instanceof TypeError;
}
check("non-writable rejects", readonlyThrew && read(dictionary, "fixed") === 1);

const frozen = Object.freeze(fill({}));
let frozenThrew = false;
try {
	write(frozen, keys[3], 100);
} catch (error) {
	frozenThrew = error instanceof TypeError;
}
check("frozen rejects", frozenThrew && read(frozen, keys[3]) === 3);

const prototype = fill(Object.create(null));
const child = Object.create(prototype);
check("inherited dictionary read", read(child, keys[5]) === 5);
write(prototype, keys[5], 500);
check(
	"prototype write visible to child",
	read(child, keys[5]) === 500 && child[keys[5]] === 500,
);
write(child, keys[6], 600);
check(
	"child write shadows prototype",
	read(child, keys[6]) === 600 && read(prototype, keys[6]) === 6,
);

const indexed = fill({});
write(indexed, "7", "index");
write(indexed, "4294967295", "string");
check("index string key", indexed[7] === "index" && read(indexed, "7") === "index");
check("non-index numeric string", read(indexed, "4294967295") === "string");
check("index enumeration first", Object.keys(indexed)[0] === "7");

for (let index = 0; index < 48; index++) globalThis["dictionaryGlobal" + index] = index;
for (let index = 0; index < 48; index++) {
	globalThis["dictionaryGlobal" + index] = globalThis["dictionaryGlobal" + index] * 2;
}
check("global dictionary writes", globalThis.dictionaryGlobal47 === 94);

let passed = 0;
for (const [name, ok] of results) {
	if (ok) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
