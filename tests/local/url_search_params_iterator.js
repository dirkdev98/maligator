const results = [];

function check(name, ok) {
	results.push([name, !!ok]);
}

function eq(name, got, want) {
	check(name + " (got " + JSON.stringify(got) + ")", got === want);
}

function throwsTypeError(name, fn) {
	let threw = false;
	try {
		fn();
	} catch (error) {
		threw = error instanceof TypeError;
	}
	check(name, threw);
}

const proto = URLSearchParams.prototype;
const sample = new URLSearchParams("a=1&b=2");
const entries = sample.entries();
const keys = sample.keys();
const values = sample.values();
const iteratorProto = Object.getPrototypeOf(entries);
const sharedIteratorProto = Object.getPrototypeOf(
	Object.getPrototypeOf([][Symbol.iterator]()),
);
const next = iteratorProto.next;

check(
	"entries keys values share iterator prototype",
	Object.getPrototypeOf(keys) === iteratorProto &&
		Object.getPrototypeOf(values) === iteratorProto,
);
check(
	"iterator prototype inherits IteratorPrototype",
	Object.getPrototypeOf(iteratorProto) === sharedIteratorProto,
);
check("iterator returns itself", entries[Symbol.iterator]() === entries);
eq(
	"params toStringTag",
	Object.prototype.toString.call(sample),
	"[object URLSearchParams]",
);
eq(
	"iterator toStringTag",
	Object.prototype.toString.call(entries),
	"[object URLSearchParams Iterator]",
);
eq("iterator next name", next.name, "next");
eq("iterator next length", next.length, 0);
check("prototype iterator aliases entries", proto[Symbol.iterator] === proto.entries);

const nextDesc = Object.getOwnPropertyDescriptor(iteratorProto, "next");
check(
	"next descriptor",
	nextDesc.value === next &&
		nextDesc.writable &&
		nextDesc.enumerable &&
		nextDesc.configurable,
);
const iteratorTagDesc = Object.getOwnPropertyDescriptor(
	iteratorProto,
	Symbol.toStringTag,
);
check(
	"iterator tag descriptor",
	iteratorTagDesc.value === "URLSearchParams Iterator" &&
		!iteratorTagDesc.writable &&
		!iteratorTagDesc.enumerable &&
		iteratorTagDesc.configurable,
);
const paramsTagDesc = Object.getOwnPropertyDescriptor(proto, Symbol.toStringTag);
check(
	"params tag descriptor",
	paramsTagDesc.value === "URLSearchParams" &&
		!paramsTagDesc.writable &&
		!paramsTagDesc.enumerable &&
		paramsTagDesc.configurable,
);

throwsTypeError("next rejects plain object", () => next.call({}));
throwsTypeError("next rejects params", () => next.call(sample));
throwsTypeError("next rejects Array iterator", () => next.call([][Symbol.iterator]()));

const appended = new URLSearchParams("a=1");
const appendedEntries = appended.entries();
appended.append("b", "2");
eq("append first", appendedEntries.next().value.join("="), "a=1");
eq("append is live", appendedEntries.next().value.join("="), "b=2");

const revived = new URLSearchParams();
const revivedValues = revived.values();
check("empty iterator initially done", revivedValues.next().done);
revived.append("x", "later");
eq("append after done is observed", revivedValues.next().value, "later");

const deleteNext = new URLSearchParams("a=1&b=2&c=3");
const deleteNextKeys = deleteNext.keys();
eq("delete-next first", deleteNextKeys.next().value, "a");
deleteNext.delete("b");
eq("delete-next observes compacted list", deleteNextKeys.next().value, "c");

const deleteCurrent = new URLSearchParams("a=1&b=2&c=3");
const deleteCurrentValues = deleteCurrent.values();
eq("delete-current first", deleteCurrentValues.next().value, "1");
deleteCurrent.delete("a");
eq("delete-current keeps numeric cursor", deleteCurrentValues.next().value, "3");

const compacted = new URLSearchParams("a=1&x=2&a=3&z=4");
const compactedEntries = compacted.entries();
eq("set-compaction first", compactedEntries.next().value.join("="), "a=1");
compacted.set("a", "new");
eq("set-compaction live next", compactedEntries.next().value.join("="), "x=2");
eq("set-compaction live tail", compactedEntries.next().value.join("="), "z=4");

const sorted = new URLSearchParams("c=1&a=2&b=3");
const sortedKeys = sorted.keys();
eq("sort first", sortedKeys.next().value, "c");
sorted.sort();
eq("sort re-reads current index", sortedKeys.next().value, "b");
eq("sort re-reads tail", sortedKeys.next().value, "c");

const associated = new URL("https://example.test/?a=1&b=2");
const associatedParams = associated.searchParams;
const associatedIterator = associatedParams.entries();
eq("associated first", associatedIterator.next().value.join("="), "a=1");
associated.search = "?x=3&y=4";
check("associated params identity", associated.searchParams === associatedParams);
eq(
	"search replacement keeps cursor and list",
	associatedIterator.next().value.join("="),
	"y=4",
);
associated.href = "https://other.test/?m=5&n=6";
check(
	"href replacement keeps params identity",
	associated.searchParams === associatedParams,
);
associatedParams.append("tail", "7");
eq("params still update URL", associated.search, "?m=5&n=6&tail=7");

class DerivedParams extends URLSearchParams {}
const derived = new DerivedParams("d=1");
check("subclass prototype", Object.getPrototypeOf(derived) === DerivedParams.prototype);
check("subclass brand", proto.get.call(derived, "d") === "1");
check("subclass iterator brand", derived.entries().next().value.join("=") === "d=1");

const independent = new URLSearchParams("a=1&b=2");
const firstIterator = independent.keys();
const secondIterator = independent.keys();
eq("independent first cursor", firstIterator.next().value, "a");
eq("independent second cursor", secondIterator.next().value, "a");
eq("independent first advances", firstIterator.next().value, "b");

function retainedAssociatedIterator() {
	const url = new URL("https://retained.test/?first=1&second=2");
	return url.searchParams.entries();
}
const retained = retainedAssociatedIterator();
for (let i = 0; i < 160; i++) {
	const churn = new URLSearchParams();
	churn.append("k" + i, "v" + i);
}
eq("iterator retains params and URL first", retained.next().value.join("="), "first=1");
eq("iterator retains params and URL second", retained.next().value.join("="), "second=2");

let passed = 0;
for (const [name, ok] of results) {
	if (ok) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
