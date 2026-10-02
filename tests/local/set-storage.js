let checks = 0;
function check(condition, message) {
	if (!condition) throw new Error(message);
	checks++;
}
const gc = globalThis.__mal_collect_garbage;
function collect() {
	if (typeof gc === "function") gc();
}

const integers = new Set();
for (let i = 0; i < 96; i++) integers.add(i);
check(integers.has(31.0) && !integers.has("31") && !integers.has(31n), "numeric queries");
integers.add(31.0);
integers.add(-0);
check(
	integers.size === 96 && Object.is(integers.values().next().value, 0),
	"canonical integers",
);
const cursor = integers.values();
check(cursor.next().value === 0, "cursor starts before widening");
integers.delete(1);
integers.add(0.25);
integers.add(NaN);
integers.add(Number.NaN);
integers.add(Infinity);
integers.add(-Infinity);
integers.add(2 ** 40);
check(integers.size === 100 && integers.has(NaN) && integers.has(31), "number widening");
const object = { marker: 42 };
const symbol = Symbol("member");
integers.add(object).add(symbol).add(31n).add(true).add(null).add(undefined);
collect();
check(
	cursor.next().value === 2 && integers.has(object) && integers.has(31n),
	"generic widening under pin",
);
const rest = Array.from(cursor);
check(
	rest[rest.length - 1] === undefined && rest.includes(symbol),
	"cursor survives widening",
);
check(cursor.next().done, "cursor permanently exhausted");
integers.add("after-exhaustion");
check(cursor.next().done, "exhausted cursor ignores additions");

const small = new Set([0, 1, 2, 3]);
const first = small.values();
const second = small.entries();
check(first.next().value === 0 && second.next().value[0] === 0, "nested small cursors");
small.delete(1);
small.delete(2);
small.add(4);
small.add(5);
check(
	Array.from(first).join(",") === "3,4,5",
	"tombstones force spill without renumbering",
);
small.clear();
small.add("new");
check(
	second.next().value.join(",") === "new,new" && second.next().done,
	"clear append with older cursor",
);
const empty = new Set();
const emptyCursor = empty.values();
empty.add("later");
check(emptyCursor.next().value === "later", "empty iterator observes first insertion");

const visits = [];
const each = new Set([1, 2, 3, 4]);
each.forEach((value, key, receiver) => {
	check(value === key && receiver === each, "forEach arguments");
	visits.push(value);
	if (value === 1) {
		each.delete(2);
		each.add(5.5);
		each.add("tail");
		collect();
	}
});
check(visits.join(",") === "1,3,4,5.5,tail", "forEach mutations and widening");
const proxySet = new Set([{ marker: 123 }]);
let observed = 0;
proxySet.forEach(
	new Proxy(function () {}, {
		get apply() {
			proxySet.clear();
			collect();
			return function (target, receiver, args) {
				check(args[0] === args[1] && args[2] === proxySet, "Proxy callback roots");
				observed = args[0].marker;
			};
		},
	}),
);
check(observed === 123, "Proxy apply getter cannot collect current member");

const strings = new Set();
for (let i = 0; i < 48; i++) strings.add("member-" + i + "x".repeat(80));
for (let i = 0; i < 48; i++)
	check(
		strings.has(["member-", i, "x".repeat(80)].join("")),
		"equal string representations",
	);
strings.add("member-0" + "x".repeat(80));
check(strings.size === 48, "string content duplicate");
const identities = new Set([object, symbol]);
identities.add(object).add(symbol);
check(
	identities.size === 2 && !identities.has({ marker: 42 }),
	"identity specialization",
);
check(new Set([1n, BigInt("1"), 1]).size === 2, "BigInt equality distinct from Number");

const left = new Set([1, 2, 3]);
const right = new Set([3, 4]);
check([...left.union(right)].join(",") === "1,2,3,4", "union");
check([...left.intersection(right)].join(",") === "3", "intersection");
check([...left.difference(right)].join(",") === "1,2", "difference");
check([...left.symmetricDifference(right)].join(",") === "1,2,4", "symmetric difference");
check(
	left.isSupersetOf(new Set([1])) &&
		!left.isSubsetOf(right) &&
		left.isDisjointFrom(new Set([9])),
	"set relations",
);
const other = {
	size: 2,
	has(value) {
		left.add("during-has");
		collect();
		return value === 1;
	},
	*keys() {
		yield 1;
		yield object;
	},
};
check([...left.union(other)].includes(object), "set-like union uses dynamic keys");
check(
	left.isSupersetOf(other) === false && left.has("during-has") === false,
	"superset uses keys",
);
const callbackSource = new Set([1, 2]);
const callbackOther = {
	size: 10,
	has(value) {
		callbackSource.add("widened");
		collect();
		return value === 1;
	},
	keys() {
		return [1].values();
	},
};
check(
	[...callbackSource.intersection(callbackOther)].join(",") === "1" &&
		callbackSource.has("widened"),
	"algebra has callback widens pinned receiver",
);

const cloneSource = new Set();
const firstCloneMember = {};
Object.defineProperty(firstCloneMember, "marker", {
	enumerable: true,
	get() {
		cloneSource.clear();
		cloneSource.add("replacement");
		collect();
		return 7;
	},
});
cloneSource.add(firstCloneMember).add({ marker: 8 }).add(cloneSource);
const clone = globalThis.structuredClone(cloneSource);
const clonedMembers = [...clone];
check(
	clone.size === 3 &&
		clonedMembers[0].marker === 7 &&
		clonedMembers[1].marker === 8 &&
		clonedMembers[2] === clone,
	"Set clone snapshot and cycle",
);
const cloneMap = new Map();
const mapFirst = {};
Object.defineProperty(mapFirst, "value", {
	enumerable: true,
	get() {
		cloneMap.clear();
		collect();
		return 9;
	},
});
cloneMap.set("first", mapFirst).set("second", { value: 10 });
const mapCopy = globalThis.structuredClone(cloneMap);
check(
	mapCopy.size === 2 && mapCopy.get("second").value === 10,
	"Map clone snapshot at shared seam",
);

const weak = new WeakSet();
weak.add(object).add(symbol);
collect();
check(
	weak.has(object) && weak.has(symbol) && !weak.has(1) && !weak.delete("missing"),
	"weak membership and mismatch queries",
);
check(weak.delete(symbol) && !weak.has(symbol), "weak deletion");
let threw = false;
try {
	weak.add(Symbol.for("registered"));
} catch (error) {
	threw = error instanceof TypeError;
}
check(threw, "WeakSet rejects registered symbols");
for (let i = 0; i < 64; i++) {
	const source = new Set([
		"first" + i,
		{ value: i },
		"third" + i,
		"fourth" + i,
		"fifth" + i,
	]);
	const abandoned = source.values();
	abandoned.next();
	if (i % 2 === 0) source.clear();
	collect();
}
console.log("set-storage PASS " + checks + "/" + checks);
