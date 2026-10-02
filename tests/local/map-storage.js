"use strict";

const collect = globalThis.__mal_collect_garbage;
if (typeof collect !== "function") throw new Error("map-storage requires MAL_HOST_GC=1");
let checks = 0;
function check(condition, name) {
	if (!condition) throw new Error(name);
	checks++;
}

const domains = [
	[0, -1, 2147483647, -2147483648, 17],
	[0.5, NaN, Infinity, -Infinity, 2147483648],
	["alpha", "beta", "gamma", "delta", "epsilon"],
	[{}, {}, Symbol("a"), Symbol("b"), {}],
	[undefined, null, false, true, 1n, "generic", {}],
];
for (const keys of domains) {
	const map = new Map();
	for (let i = 0; i < keys.length; i++) map.set(keys[i], { index: i });
	collect();
	check(map.size === keys.length, "domain size");
	for (let i = 0; i < keys.length; i++)
		check(map.has(keys[i]) && map.get(keys[i]).index === i, "domain values survive");
	check(
		!map.has(Symbol("missing")) && !map.delete(Symbol("missing")),
		"mismatched queries",
	);
	const order = Array.from(map.keys());
	for (let i = 0; i < keys.length; i++)
		check(Object.is(order[i], keys[i]), "domain order");
}
const numeric = new Map([
	[-0, "zero"],
	[NaN, "nan"],
	[1, "number"],
	[1n, "bigint"],
]);
check(
	numeric.get(0) === "zero" && 1 / numeric.keys().next().value === Infinity,
	"canonical zero",
);
check(
	numeric.get(Number("invalid")) === "nan" &&
		numeric.get(1n) === "bigint" &&
		numeric.get(1) === "number",
	"NaN and BigInt equality",
);
const strings = new Map([["long-equal-key", 1]]);
strings.set("!long-equal-key".slice(1), 2);
check(
	strings.size === 1 && strings.get(["long", "equal", "key"].join("-")) === 2,
	"equal string update",
);

const transitions = new Map([
	[0, "zero"],
	[1, "one"],
]);
const first = transitions.entries();
const second = transitions.values();
check(
	first.next().value.join(":") === "0:zero" && second.next().value === "zero",
	"tiny cursors",
);
transitions.delete(1);
for (let i = 2; i < 80; i++) transitions.set(i, "value" + i);
transitions.set(2, "updated");
transitions.set(0.5, "fraction");
const identity = {};
transitions.set(identity, "identity");
check(
	first.next().value.join(":") === "2:updated" && second.next().value === "updated",
	"spill and update preserve cursors",
);
transitions.clear();
transitions.set("after-clear", { alive: true });
collect();
check(
	first.next().value[0] === "after-clear" && second.next().value.alive,
	"clear append survives widening",
);
check(first.next().done && second.next().done, "cursors exhaust");
transitions.set("later", 2);
check(first.next().done && second.next().done, "exhaustion remains final");

const visited = [];
const each = new Map([
	[0, 10],
	[1, 11],
	[2, 12],
]);
each.forEach((value, key, receiver) => {
	check(receiver === each && value === key + 10, "forEach arguments");
	visited.push(key);
	if (key === 0) {
		each.delete(1);
		each.set(3, 13);
		each.set(0.5, 10.5);
		collect();
	}
});
check(visited.join(",") === "0,2,3,0.5", "forEach mutation and widening");
const proxyMap = new Map([[{ identity: 123 }, { payload: 456 }]]);
let proxyValue = 0;
proxyMap.forEach(
	new Proxy(function () {}, {
		get apply() {
			proxyMap.clear();
			collect();
			return (target, receiver, args) => {
				check(args[2] === proxyMap, "Proxy callback receiver roots");
				proxyValue = args[0].payload + args[1].identity;
			};
		},
	}),
);
check(proxyValue === 579, "Proxy apply getter preserves current pair");

const insertion = new Map();
const computed = insertion.getOrInsertComputed("key", (key) => {
	insertion.set(key, "during-callback");
	collect();
	return "result";
});
check(
	computed === "result" && insertion.get("key") === "result",
	"computed insertion revalidates after callback",
);
check(
	insertion.getOrInsert("key", "unused") === "result" &&
		insertion.getOrInsert("next", 2) === 2,
	"getOrInsert updates",
);
const grouped = Map.groupBy([1, 2, 3, 4, 5], (value) => value & 1);
check(
	grouped.get(1).join(",") === "1,3,5" && grouped.get(0).join(",") === "2,4",
	"groupBy stored arrays",
);
const copied = new Map(grouped.entries());
check(
	copied.size === 2 && copied.get(1) === grouped.get(1),
	"constructor consumes Map entries",
);

const cloneSource = new Map();
const cloneKey = {};
Object.defineProperty(cloneKey, "marker", {
	enumerable: true,
	get() {
		cloneSource.clear();
		collect();
		return 7;
	},
});
cloneSource.set(cloneKey, { value: 8 }).set("cycle", cloneSource);
const clone = structuredClone(cloneSource);
const cloneEntries = [...clone];
check(
	clone.size === 2 &&
		cloneEntries[0][0].marker === 7 &&
		cloneEntries[0][1].value === 8 &&
		clone.get("cycle") === clone,
	"clone snapshots rooted pairs and cycles",
);

const weakKeys = Array.from({ length: 80 }, () => ({}));
const weak = new WeakMap();
for (let i = 0; i < weakKeys.length; i++) weak.set(weakKeys[i], { index: i });
collect();
for (let i = 0; i < weakKeys.length; i++)
	check(weak.get(weakKeys[i]).index === i, "weak values survive marked keys");
check(
	!weak.has(1) && !weak.delete("invalid") && weak.get(null) === undefined,
	"weak mismatched queries",
);
const weakSymbol = Symbol("weak-key");
weak.set(weakSymbol, { value: 99 });
collect();
check(
	weak.get(weakSymbol).value === 99 && weak.delete(weakSymbol) && !weak.has(weakSymbol),
	"weak symbol lifecycle",
);
let rejected = false;
try {
	weak.set(Symbol.for("registered"), 1);
} catch (error) {
	rejected = error instanceof TypeError;
}
check(rejected, "registered weak symbol rejected");
for (let trial = 0; trial < 64; trial++) {
	const abandoned = new Map(
		Array.from({ length: 20 }, (_, index) => ["key" + index, { index }]),
	);
	const cursor = abandoned.entries();
	cursor.next();
	for (let index = 1; index < 18; index++) abandoned.delete("key" + index);
	if (trial % 2 === 0) abandoned.clear();
	collect();
}
console.log("map-storage PASS " + checks + "/" + checks);
