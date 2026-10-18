// for-in iterates its keys internally: patched array iterator methods never run.
const out = [];
const keys = (o) => {
	const r = [];
	for (const k in o) r.push(k);
	return r.join(",");
};
const a = { x: 1, y: 2, z: 3 };
const b = { x: 4, y: 5, z: 6 };
out.push(keys(a), keys(b));
// Nested loops over one shape share its key list.
const pairs = [];
for (const k1 in a) for (const k2 in b) pairs.push(k1 + k2);
out.push(pairs.join(","));
// Deleting a later key skips it; added keys are not visited.
const d = { p: 1, q: 2, r: 3 };
const seen = [];
for (const k in d) {
	seen.push(k);
	if (k === "p") {
		delete d.r;
		d.s = 4;
	}
}
out.push(seen.join(","), keys(d));
// break leaves the shared list intact for the next loop.
let first = "";
for (const k in a) {
	first = k;
	break;
}
out.push(first, keys(a));
// Prototype keys and shadowing.
const proto = { inherited: 1, x: 9 };
const child = Object.create(proto);
child.own = 2;
child.x = 3;
out.push(keys(child));
out.push(keys([10, 20]), keys("ab"), keys(null), keys(undefined), keys(5));
// for-in iterates internally, whatever the array iterator protocol says.
const originalIterator = Array.prototype[Symbol.iterator];
const arrayIteratorPrototype = Object.getPrototypeOf([][Symbol.iterator]());
const originalNext = arrayIteratorPrototype.next;
let observed = 0;
Array.prototype[Symbol.iterator] = function* () {
	observed++;
	yield "hacked";
};
arrayIteratorPrototype.next = function () {
	observed++;
	return { done: true };
};
arrayIteratorPrototype.return = function () {
	observed++;
	return {};
};
out.push(keys(a), keys(child));
for (const k in a) {
	if (k === "x") break;
}
Array.prototype[Symbol.iterator] = originalIterator;
arrayIteratorPrototype.next = originalNext;
delete arrayIteratorPrototype.return;
out.push(`observed ${observed}`);
// Values through computed loads.
let sum = 0;
for (const k in b) sum += b[k];
out.push(sum);
console.log(out.join("\n"));
