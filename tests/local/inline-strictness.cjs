// A callee keeps its own strictness wherever its body runs: a strict function
// assigning a read-only binding found through `with` throws, and a sloppy function
// assigning an undeclared name creates a global even when its caller is strict.
function readOnly() {
	const object = { x: 1 };
	Object.defineProperty(object, "x", { writable: false });
	return object;
}
function strictThroughWith() {
	with (readOnly()) {
		try {
			(function () {
				"use strict";
				x = 2;
			})();
			return "assigned";
		} catch (error) {
			return error.constructor.name;
		}
	}
}
function sloppyAssign() {
	createdBySloppyCallee = 3;
}
function strictCaller() {
	"use strict";
	sloppyAssign();
	return typeof globalThis.createdBySloppyCallee;
}
const log = [];
for (let round = 0; round < 3; round++) log.push(strictThroughWith(), strictCaller());
console.log(log.join(","));
