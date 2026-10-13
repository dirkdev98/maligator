const foreign = $262.createRealm().global;
const collectGarbage =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});
function check(ok, message) {
	if (!ok) throw new Error(message);
}
const marker = {};
function boxedAcrossCollection() {
	collectGarbage();
	const prototype = Object.getPrototypeOf(this);
	collectGarbage();
	check(
		prototype === Number.prototype && this.valueOf() === 29,
		"receiver survives repeated reads",
	);
	return this;
}
check(boxedAcrossCollection.call(29).valueOf() === 29, "direct boxed call");
check(
	Reflect.apply(boxedAcrossCollection, 29, []).valueOf() === 29,
	"generic boxed call",
);
let calls = 0;
function sloppy(value, index) {
	check(
		Object.getPrototypeOf(this) === Number.prototype && this.valueOf() === 17,
		"callee realm primitive boxing",
	);
	check(arguments.length === 2, "mapper arity");
	collectGarbage();
	calls++;
	return value + index;
}
const mapped = foreign.Array.from([2, 3], sloppy, 17);
check(
	Object.getPrototypeOf(mapped) === foreign.Array.prototype && mapped.join() === "2,4",
	"caller result realm",
);
function strict(value, index) {
	"use strict";
	check(this === 23 && arguments.length === 2, "strict receiver");
	collectGarbage();
	return value + index;
}
const typed = foreign.Float64Array.from([4, 5], strict, 23);
check(
	Object.getPrototypeOf(typed) === foreign.Float64Array.prototype &&
		typed.join() === "4,6",
	"typed result realm",
);
function outer(match, index, source) {
	"use strict";
	check(this === undefined && source === "x-x", "outer callback realm");
	const nested = foreign.JSON.parse('{"n":2}', function reviver(key, value, context) {
		check(Object.getPrototypeOf(this) === foreign.Object.prototype, "foreign holder");
		check(Object.getPrototypeOf(context) === foreign.Object.prototype, "foreign context");
		collectGarbage();
		return value;
	});
	check(
		Object.getPrototypeOf(nested) === foreign.Object.prototype,
		"nested result realm",
	);
	let caught;
	try {
		foreign.Array.from([1], function fail() {
			"use strict";
			collectGarbage();
			throw marker;
		});
	} catch (error) {
		caught = error;
	}
	check(
		caught === marker && Object.getPrototypeOf({}) === Object.prototype,
		"nested throw restoration",
	);
	return index;
}
const replaced = foreign.String.prototype.replaceAll.call("x-x", "x", outer);
check(replaced === "0-2", "replacement result");
let factor = 2;
function lazy(value, index) {
	"use strict";
	check(this === undefined && arguments.length === 2, "lazy receiver");
	collectGarbage();
	return value * factor + index;
}
const helper = foreign.Iterator.prototype.map.call([2, 3].values(), lazy);
check(helper.next().value === 4, "foreign helper first");
factor = 3;
collectGarbage();
check(helper.toArray().join() === "10", "foreign helper retained capture");
const evalCallback = foreign.Function(
	"value",
	"index",
	"return this===globalThis?value+index:-1",
);
check(Array.from([2, 3], evalCallback).join() === "2,4", "eval callback fallback");
check(calls === 2, "mapper call count");
console.log("owned-realms", mapped.join(), typed.join(), replaced, calls);
