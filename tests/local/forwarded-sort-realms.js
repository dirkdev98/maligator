const foreign = $262.createRealm().global;
const collectGarbage = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});
function forward(receiver, callback, copy) {
	return copy ? receiver.toSorted(callback) : receiver.sort(callback);
}
globalThis.forwardRealmSort = forward;
const callback = foreign.Function(
	"a",
	"b",
	"if(this!==globalThis||arguments.length!==2)throw new Error('foreign this'); return a<b?-1:a>b?1:0;",
);
const results = [];
for (const input of [[3, 1, 2], new BigInt64Array([3n, 1n, 2n])]) {
	results.push(globalThis.forwardRealmSort(input, callback, false).join(","));
	results.push(globalThis.forwardRealmSort(input, callback, true).join(","));
}
for (const input of [
	new foreign.Array(3, 1, 2),
	new foreign.BigInt64Array([3n, 1n, 2n]),
]) {
	const copy = globalThis.forwardRealmSort(
		input,
		function local(a, b) {
			"use strict";
			collectGarbage();
			if (this !== undefined) throw new Error("local this");
			return a < b ? -1 : a > b ? 1 : 0;
		},
		true,
	);
	if (!(copy instanceof input.constructor)) throw new Error("foreign output realm");
	results.push(copy.join(","));
}
console.log("forwarded-sort-realms", results.join("|"));
