"use strict";
const foreign = $262.createRealm().global;
const output = [];
const collect = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});
function check(condition) {
	if (!condition) throw new Error("collection realm mismatch");
}
const map = new Map([["key", "value"]]);
Object.defineProperty(map, "forEach", { value: foreign.Map.prototype.forEach });
map.forEach(function localMap(v, k, m) {
	check(v === "value" && k === "key" && m === map && this === 7);
	collect();
}, 7);
const set = new Set(["value"]);
Object.defineProperty(set, "forEach", { value: foreign.Set.prototype.forEach });
set.forEach(function localSet(v, k, s) {
	check(v === k && s === set && this === 7);
	collect();
}, 7);
for (const [receiver, method] of [
	[{}, foreign.Map.prototype.forEach],
	[{}, foreign.Set.prototype.forEach],
]) {
	try {
		method.call(receiver, () => {});
	} catch (error) {
		output.push(error instanceof foreign.TypeError, error instanceof TypeError);
	}
}
const box = foreign.Function(
	"return function(value,key,owner){ owner.boxed = typeof this === 'object' && this instanceof Number && this.valueOf() === 7; owner.same = value === key; };",
)();
const localMap = new Map([[1, 1]]);
localMap.forEach(box, 7);
check(localMap.boxed && localMap.same);
const localSet = new Set([1]);
localSet.forEach(box, 7);
check(localSet.boxed && localSet.same);
const marker = {};
try {
	map.forEach(function localThrow() {
		throw marker;
	});
} catch (error) {
	check(error === marker);
	output.push("throw");
}
const OriginalMap = Map;
const OriginalSet = Set;
try {
	globalThis.Map = function () {
		return new foreign.Map([["foreign", "map"]]);
	};
	globalThis.Set = function () {
		return new foreign.Set(["set"]);
	};
	const foreignMap = new Map();
	foreignMap.forEach(function foreignMapCallback(value, key, owner) {
		check(value === "map" && key === "foreign" && owner === foreignMap && this === 7);
		collect();
	}, 7);
	const foreignSet = new Set();
	foreignSet.forEach(function foreignSetCallback(value, duplicate, owner) {
		check(value === "set" && duplicate === value && owner === foreignSet && this === 7);
		collect();
	}, 7);
} finally {
	globalThis.Map = OriginalMap;
	globalThis.Set = OriginalSet;
}
console.log(JSON.stringify(output));
