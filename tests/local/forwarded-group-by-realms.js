const foreign = $262.createRealm().global;
const callback = foreign.Function(
	"value",
	"index",
	"return this === globalThis ? index & 1 : -1",
);
const a = Object.groupBy([2, 3, 4], callback);
const b = Map.groupBy([2, 3, 4], callback);
function local(value, index) {
	"use strict";
	if (this !== undefined || arguments.length !== 2) throw new Error("callback realm");
	return index & 1;
}
const c = foreign.Object.groupBy([2, 3, 4], local);
const d = foreign.Map.groupBy([2, 3, 4], local);
if (
	Object.getPrototypeOf(c) !== null ||
	Object.getPrototypeOf(c[0]) !== foreign.Array.prototype ||
	Object.getPrototypeOf(d) !== foreign.Map.prototype ||
	Object.getPrototypeOf(d.get(0)) !== foreign.Array.prototype
)
	throw new Error("group result realm");
console.log("group-realms", a[0].join(), b.get(0).join(), c[0].join(), d.get(0).join());
