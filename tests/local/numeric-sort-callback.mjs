function compare(a, b) {
	return a - b;
}
function sortInput(receiver) {
	return receiver.sort(compare);
}
function copyInput(receiver) {
	return receiver.toSorted(compare);
}
function show(view) {
	return Array.from(view, (x) => (Object.is(x, -0) ? "-0" : String(x))).join(",");
}
for (const Type of [
	Int8Array,
	Uint8Array,
	Uint8ClampedArray,
	Int16Array,
	Uint16Array,
	Int32Array,
	Uint32Array,
	Float32Array,
	Float64Array,
]) {
	const input = new Type([7, 2, 7, 1, 5, 4, 0, 6, 3]);
	console.log(Type.name, show(copyInput(input)), show(input), show(sortInput(input)));
}
function equal(a, b) {
	return ((a - a) * 0) / (b - b);
}
console.log("stable", show(new Float64Array([-0, 0, NaN, 4, -2]).sort(equal)));
console.log("stable-array", show([-0, 0, NaN, 4, -2].sort(equal)));
console.log("stable-array-copy", show([-0, 0, NaN, 4, -2].toSorted(equal)));
console.log(
	"empty",
	show(sortInput(new Float64Array())),
	show(copyInput(new Float64Array([3]))),
);
console.log("array", sortInput([4, 1, 3, 2]).join(","));
console.log(
	"override",
	sortInput({
		sort(fn) {
			return fn(9, 4) + 100;
		},
	}),
);
console.log(
	"copy-override",
	copyInput({
		toSorted(fn) {
			return fn(9, 4) + 200;
		},
	}),
);
try {
	sortInput(new BigInt64Array([3n, 1n]));
} catch (error) {
	console.log("bigint", error.name);
}
try {
	sortInput({ sort: Float64Array.prototype.sort });
} catch (error) {
	console.log("brand", error.name);
}
globalThis.calls = 0;
globalThis.throwComparator = false;
globalThis.reenter = true;
function effectsCompare(a, b) {
	globalThis.calls++;
	globalThis.garbage = { values: [a, b], padding: new Uint8Array(64) };
	if (globalThis.reenter) {
		globalThis.reenter = false;
		globalThis.nested = new Float64Array([4, 1, 2]).toSorted((x, y) => y - x).join(",");
		globalThis.active[0] = 99;
	}
	if (globalThis.throwComparator) throw new Error("comparator");
	return a - b;
}
globalThis.active = new Float64Array([4, 3, 2, 1]);
console.log(
	"effects",
	show(globalThis.active.sort(effectsCompare)),
	globalThis.nested,
	globalThis.calls > 0,
);
globalThis.throwComparator = true;
const throwing = new Float64Array([8, 2, 5]);
try {
	throwing.sort(effectsCompare);
} catch (error) {
	console.log("throw", error.message, show(throwing));
}
globalThis.throwComparator = false;
console.log("after-throw", show(new Float64Array([5, 2, 7]).sort(effectsCompare)));
globalThis.coercions = 0;
const mixed = [
	4,
	"2",
	{
		valueOf() {
			globalThis.coercions++;
			return 3;
		},
		toString() {
			return "object:3";
		},
	},
	1,
];
console.log("mixed", sortInput(mixed).map(String).join(","), globalThis.coercions > 0);
const sparse = [4, , undefined, 1];
console.log(
	"sparse-copy",
	copyInput(sparse).join(","),
	Object.keys(copyInput(sparse)).join(","),
);
console.log("sparse-sort", sortInput(sparse).join(","), Object.keys(sparse).join(","));
try {
	sortInput([2, Symbol("x"), 1]);
} catch (error) {
	console.log("array-symbol", error.name);
}
globalThis.compare = compare;
function changingComparator(view) {
	return view.sort(globalThis.compare);
}
console.log("original-callback", show(changingComparator(new Float64Array([1, 3, 2]))));
Object.defineProperty(globalThis, "compare", { value: (a, b) => b - a });
console.log("replaced-callback", show(changingComparator(new Float64Array([1, 3, 2]))));
console.log(
	"array-copy-effects",
	new Array(3).fill(4).toSorted(effectsCompare).join(","),
);

function detachedSort(receiver) {
	const sort = receiver.sort;
	return sort.call(receiver, compare);
}
function detachedCopy(receiver) {
	return receiver.toSorted.call(receiver, compare);
}
for (const input of [[3, 1, 2], new Float64Array([3, 1, 2]), [3, "1", 2]]) {
	console.log(
		"detached",
		show(detachedCopy(input)),
		show(input),
		show(detachedSort(input)),
	);
}
console.log("prototype-call", show(Array.prototype.sort.call([4, 1, 2], compare)));
const customSort = function (fn) {
	return fn(8, 3) + this.extra;
};
console.log("detached-override", detachedSort({ sort: customSort, extra: 100 }));
customSort.call = function (receiver, fn) {
	return fn(9, 2) + receiver.extra + 1;
};
console.log("detached-call-override", detachedSort({ sort: customSort, extra: 200 }));
console.log(
	"detached-noncallable",
	detachedSort({
		sort: {
			call(receiver, fn) {
				return fn(7, 1);
			},
		},
	}),
);
try {
	detachedSort({ sort: 3 });
} catch (error) {
	console.log("detached-invalid", error.name);
}
try {
	detachedSort(new BigInt64Array([2n, 1n]));
} catch (error) {
	console.log("detached-bigint", error.name);
}
globalThis.throwComparator = true;
try {
	Float64Array.prototype.sort.call(new Float64Array([2, 1]), effectsCompare);
} catch (error) {
	console.log("detached-throw", error.message);
}
globalThis.throwComparator = false;
console.log(
	"detached-effects",
	show(Float64Array.prototype.toSorted.call(new Float64Array([5, 2, 7]), effectsCompare)),
);
function residue(a, b) {
	return (a % 7) - (b % 7);
}
function descending(a, b) {
	return b - a;
}
const scrambled = Array.from({ length: 600 }, (_, index) => (index * 211 + 17) % 600);
// NaN elements would make every comparator inconsistent and the order implementation-defined.
const special = Array.from(
	{ length: 300 },
	(_, index) => [0, -0, Infinity, -Infinity, 3, -3, 1.5][(index * 5) % 7],
);
const checksum = (values) => {
	let hash = 0;
	for (const unit of show(values)) hash = (hash * 31 + unit.charCodeAt(0)) % 1_000_003;
	return hash;
};
// Each site names its comparator so the compiled sort can admit it directly.
const sorts = {
	residue: (values) => [...values].sort(residue),
	residueCopy: (values) => values.toSorted(residue),
	descending: (values) => [...values].sort(descending),
	descendingCopy: (values) => values.toSorted(descending),
	ascending: (values) => [...values].sort(compare),
	ascendingCopy: (values) => values.toSorted(compare),
};
for (const [name, input] of [
	["scrambled", scrambled],
	["presorted", scrambled.toSorted(compare)],
	["reversed", scrambled.toSorted(descending)],
	["special", special],
]) {
	console.log(
		name,
		Object.entries(sorts)
			// Infinity % 7 is NaN, which would make the residue comparator inconsistent.
			.filter(([kind]) => name !== "special" || !kind.startsWith("residue"))
			.map(([kind, sort]) => `${kind}=${checksum(sort(input))}`)
			.join(" "),
	);
}
