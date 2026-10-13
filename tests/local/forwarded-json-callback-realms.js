const foreign = $262.createRealm().global;
const callback = foreign.Function(
	"key",
	"value",
	"context",
	"if (Object.getPrototypeOf(this) === Object.prototype) throw new Error('holder realm'); if(arguments.length===3 && Object.getPrototypeOf(context)===Object.prototype) throw new Error('context realm'); return value;",
);
const a = JSON.parse('{"a":1}', callback);
const b = JSON.stringify(a, callback);
let calls = 0;
function local(key, value, context) {
	"use strict";
	if (Object.getPrototypeOf(this) !== foreign.Object.prototype)
		throw new Error("foreign holder");
	if (
		arguments.length === 3 &&
		Object.getPrototypeOf(context) !== foreign.Object.prototype
	)
		throw new Error("foreign context");
	calls++;
	return value;
}
const c = foreign.JSON.parse('{"a":2}', local);
const d = foreign.JSON.stringify(c, local);
if (
	Object.getPrototypeOf(a) !== Object.prototype ||
	Object.getPrototypeOf(c) !== foreign.Object.prototype ||
	b !== '{"a":1}' ||
	d !== '{"a":2}' ||
	calls !== 4
)
	throw new Error("JSON realm results");
console.log("json-realms", b, d, calls);
