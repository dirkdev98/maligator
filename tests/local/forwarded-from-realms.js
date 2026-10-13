const foreign = $262.createRealm().global;
const callback = foreign.Function(
	"value",
	"index",
	"return [value + index, this === globalThis].join(':')",
);
const a = Array.from([2, 3], callback);
const b = Float64Array.from(
	[2, 3],
	foreign.Function("value", "index", "return this === globalThis ? value + index : -1"),
);
function local(value, index) {
	"use strict";
	if (this !== undefined || arguments.length !== 2)
		throw new Error("local realm callback");
	return value + index;
}
const c = foreign.Array.from([2, 3], local);
const d = foreign.Float64Array.from({ 0: 2, 1: 3, length: 2 }, local);
console.log("from-realms", a.join(), b.join(), c.join(), d.join());
