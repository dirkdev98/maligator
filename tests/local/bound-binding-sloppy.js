// Sloppy targets of bound functions held in captured bindings: a primitive bound
// `this` becomes a wrapper object and a nullish one the global object at each call.
(function () {
	const results = [];
	function sloppyThis(value) {
		return `${typeof this}:${this === globalThis}:${value}`;
	}
	function sloppyOffset(prefix, value) {
		return prefix + value + this.offset;
	}
	function strictThis(value) {
		"use strict";
		return `${typeof this}:${value}`;
	}
	function wrapper() {
		return this;
	}
	const boundUndefined = sloppyThis.bind(undefined);
	const boundNull = sloppyThis.bind(null);
	const boundNumber = sloppyThis.bind(7);
	const boundOffset = sloppyOffset.bind({ offset: 3 }, 2);
	const boundStrict = strictThis.bind(7);
	const boundWrapper = wrapper.bind(5);

	function run(rounds) {
		let total = 0;
		const seen = new Set();
		for (let index = 0; index < rounds; index++) {
			seen.add(boundUndefined(index & 1));
			seen.add(boundNull(index & 1));
			seen.add(boundNumber(index & 1));
			seen.add(boundStrict(index & 1));
			total += boundOffset(index);
		}
		return `${total}/${[...seen].join("|")}`;
	}
	function wrappers(rounds) {
		const objects = [];
		for (let index = 0; index < rounds; index++) objects.push(boundWrapper());
		return `${typeof objects[0]}:${objects[0] === objects[1]}:${objects[0] instanceof Number}:${objects.reduce((sum, value) => sum + value, 0)}`;
	}
	results.push(`sloppy=${run(16)}`);
	results.push(`wrappers=${wrappers(4)}`);
	console.log(results.join("\n"));
})();
