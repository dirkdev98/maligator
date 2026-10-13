const foreign = $262.createRealm().global;
const collectGarbage = typeof globalThis.gc === "function" ? globalThis.gc : () => {};
function forward(receiver, callback, context) {
	return receiver.map(callback, context);
}
globalThis.forwardRealmCallback = forward;
const callback = foreign.Function(
	"value",
	"index",
	"owner",
	"return [this, value + index, arguments.length, owner];",
);
const values = [2, 4];
const result = globalThis.forwardRealmCallback(values, callback, 17);
if (
	!(result[0][0] instanceof foreign.Number) ||
	result[0][0].valueOf() !== 17 ||
	result[1][1] !== 5 ||
	result[1][2] !== 3 ||
	result[1][3] !== values
)
	throw new Error("foreign callback transport");
const borrowed = { 0: 7, length: 1, map: foreign.Array.prototype.map };
const output = globalThis.forwardRealmCallback(
	borrowed,
	function visit(value, index, owner) {
		"use strict";
		collectGarbage();
		if (this !== 23 || owner !== borrowed || arguments.length !== 3)
			throw new Error("borrowed method callback");
		return value + index;
	},
	23,
);
if (!(output instanceof foreign.Array) || output[0] !== 7)
	throw new Error("foreign result realm");
console.log("forwarded-realms", result[0][1], result[1][1], output[0]);
