const mode = process.env.ITERATOR_CALLBACK_KIND || "all";
const collectGarbage = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});
function check(value, message) {
	if (!value) throw new Error(message);
}
function forwardTerminal(iterator, method, callbacks, pick) {
	let callback = callbacks[0];
	if (pick) callback = callbacks[1];
	return Iterator.prototype[method].call(iterator, callback);
}
function forwardReduce(iterator, callback, initial, hasInitial) {
	return hasInitial
		? Iterator.prototype.reduce.call(iterator, callback, initial)
		: Iterator.prototype.reduce.call(iterator, callback);
}
globalThis.forwardTerminal = forwardTerminal;
globalThis.forwardReduce = forwardReduce;
function makeIterator(values, log, close) {
	let index = 0;
	return {
		get next() {
			log.push("get-next");
			return function next() {
				collectGarbage();
				log.push("next" + index);
				return index < values.length
					? { value: values[index++], done: false }
					: { done: true };
			};
		},
		get return() {
			log.push("get-return");
			return close;
		},
	};
}
function runForEach() {
	const object = { id: 3 },
		values = [object, undefined, 4n],
		log = [],
		seen = [];
	const callback = function callback(value, index, missing = 9, ...rest) {
		check(
			this === globalThis && arguments.length === 2 && missing === 9 && rest.length === 0,
			"sloppy exact arguments",
		);
		check(value === values[index], "element identity");
		collectGarbage();
		seen.push(index);
		if (index === 0) values.push("last");
		return { ignored: true };
	};
	const result = globalThis.forwardTerminal(
		makeIterator(values, log),
		"forEach",
		[callback],
		false,
	);
	check(
		result === undefined && seen.join() === "0,1,2,3",
		"live traversal and ignored return",
	);
	check(
		log.join() === "get-next,next0,next1,next2,next3,next4",
		"next snapshot and order",
	);
	let sum = 0;
	function make(factor) {
		return function captured(value, index) {
			"use strict";
			check(this === undefined && arguments.length === 2, "strict callback this");
			sum += value * factor + index;
		};
	}
	globalThis.forwardTerminal([2, 3].values(), "forEach", [make(2), make(3)], true);
	check(sum === 16, "forwarded phi captures");
	console.log("forEach", seen.join(), sum, log.join());
}
function runReduce() {
	const values = [{ value: 2 }, { value: 3 }],
		initial = { sum: 0 },
		log = [];
	const result = globalThis.forwardReduce(
		makeIterator(values, log),
		function reducer(acc, value, index, missing = 7) {
			check(
				arguments.length === 3 &&
					missing === 7 &&
					acc === initial &&
					value === values[index],
				"reduce arguments and alias",
			);
			collectGarbage();
			acc.sum += value.value + index;
			return acc;
		},
		initial,
		true,
	);
	check(result === initial && result.sum === 6, "accumulator identity and rooting");
	let calls = 0;
	const total = globalThis.forwardReduce(
		[1n, 2n, 3n].values(),
		function bigint(acc, value, index) {
			calls++;
			check(index === calls, "no initial index");
			return acc + value;
		},
		null,
		false,
	);
	check(total === 6n && calls === 2, "BigInt reduction");
	const explicit = globalThis.forwardReduce(
		[4].values(),
		function missing(acc, value, index) {
			check(acc === undefined && index === 0, "explicit undefined initial");
			return value;
		},
		undefined,
		true,
	);
	const single = globalThis.forwardReduce(
		[initial].values(),
		function unreachable() {
			throw new Error("single value callback");
		},
		null,
		false,
	);
	let caught;
	try {
		globalThis.forwardReduce([].values(), function empty() {}, null, false);
	} catch (error) {
		caught = error;
	}
	check(
		explicit === 4 && single === initial && caught instanceof TypeError,
		"empty and single reduction",
	);
	console.log("reduce", result.sum, String(total), calls, explicit, log.join());
}
function runPredicates() {
	const found = { id: 2 },
		values = [{ id: 1 }, found, { id: 3 }],
		output = [];
	for (const method of ["some", "every", "find"]) {
		const log = [];
		let calls = 0,
			closes = 0;
		const result = globalThis.forwardTerminal(
			makeIterator(values, log, function close() {
				closes++;
				collectGarbage();
				return {};
			}),
			method,
			[
				function predicate(value, index) {
					"use strict";
					check(
						this === undefined && arguments.length === 2 && value === values[index],
						"predicate arguments",
					);
					calls++;
					collectGarbage();
					return method === "every" ? index === 0 : index === 1;
				},
			],
			false,
		);
		check(calls === 2 && closes === 1, "early close exactly once");
		check(
			method === "find" ? result === found : result === (method === "some"),
			"predicate result identity",
		);
		output.push(method + ":" + log.join());
	}
	check(
		globalThis.forwardTerminal([].values(), "some", [() => true], false) === false,
		"empty some",
	);
	check(
		globalThis.forwardTerminal([].values(), "every", [() => false], false) === true,
		"empty every",
	);
	check(
		globalThis.forwardTerminal([].values(), "find", [() => true], false) === undefined,
		"empty find",
	);

	const fresh = globalThis.forwardTerminal(
		{
			next() {
				return { value: { token: 17 }, done: false };
			},
			return() {
				collectGarbage();
				return {};
			},
		},
		"find",
		[
			function accept() {
				collectGarbage();
				return true;
			},
		],
		false,
	);
	check(fresh.token === 17, "find roots an otherwise unreferenced value across close");
	console.log("predicates", output.join(";"));
}
function runAbrupt() {
	const marker = { callback: true },
		closeMarker = { close: true },
		output = [];
	for (const method of ["forEach", "reduce", "some", "every", "find"]) {
		let calls = 0,
			caught;
		const log = [];
		const iterator = makeIterator([1, 2], log, function close() {
			collectGarbage();
			throw closeMarker;
		});
		const callback = function fail() {
			calls++;
			collectGarbage();
			throw marker;
		};
		try {
			if (method === "reduce") globalThis.forwardReduce(iterator, callback, 0, true);
			else globalThis.forwardTerminal(iterator, method, [callback], false);
		} catch (error) {
			caught = error;
		}
		check(
			caught === marker && calls === 1 && log.join() === "get-next,next0,get-return",
			"callback throw precedence",
		);
		let closes = 0;
		const bad = {
			next() {
				throw marker;
			},
			return() {
				closes++;
				return {};
			},
		};
		try {
			if (method === "reduce") globalThis.forwardReduce(bad, callback, 0, true);
			else globalThis.forwardTerminal(bad, method, [callback], false);
		} catch (error) {
			caught = error;
		}
		check(caught === marker && closes === 0 && calls === 1, "next abrupt does not close");
		output.push(method);
	}
	for (const method of ["some", "every", "find"]) {
		let caught;
		try {
			globalThis.forwardTerminal(
				makeIterator([1], [], function close() {
					throw closeMarker;
				}),
				method,
				[
					function predicate() {
						return method !== "every";
					},
				],
				false,
			);
		} catch (error) {
			caught = error;
		}
		check(caught === closeMarker, "normal early close throw");
	}

	const validation = [];
	let caught;
	try {
		globalThis.forwardTerminal(
			{
				get next() {
					validation.push("next");
					return () => ({ done: true });
				},
				get return() {
					validation.push("return");
					return function close() {
						validation.push("close");
						return {};
					};
				},
			},
			"forEach",
			[null],
			false,
		);
	} catch (error) {
		caught = error;
	}
	check(
		caught instanceof TypeError && validation.join() === "return,close",
		"noncallable callback closes before reading next",
	);
	console.log("abrupt", output.join());
}
function runReentry() {
	const log = [];
	let first = true,
		sum = 0;
	const callback = function nested(value, index) {
		collectGarbage();
		sum += value + index;
		if (value === 2)
			globalThis.forwardTerminal([7].values(), "forEach", [callback], false);
	};
	const iterator = {
		next() {
			if (!first) return { done: true };
			first = false;
			const inner = globalThis.forwardReduce(
				[3, 4].values(),
				function add(acc, value) {
					return acc + value;
				},
				0,
				true,
			);
			log.push(inner);
			return { value: 2, done: false };
		},
	};
	globalThis.forwardTerminal(iterator, "forEach", [callback], false);
	const result = globalThis.forwardTerminal(
		makeIterator([9], [], function close() {
			globalThis.forwardTerminal([5].values(), "forEach", [callback], false);
			return {};
		}),
		"find",
		[
			function predicate() {
				return true;
			},
		],
		false,
	);
	check(
		sum === 14 && result === 9 && log.join() === "7",
		"nested next callback and return restore outer context",
	);
	console.log("reentry", sum, result, log.join());
}
function runArity() {
	const output = [];
	const shared = function shared(value, index, owner) {
		let number = index;
		for (let turn = 0; turn < 2; turn++) number += 1;
		if (arguments.length === 3 && typeof owner === "object") {
			globalThis.forwardTerminal(["a", "b"].values(), "forEach", [shared], false);
			output.push(globalThis.forwardReduce([8].values(), shared, 3, true));
			let caught;
			try {
				globalThis.forwardReduce([8n].values(), shared, 3, true);
			} catch (error) {
				caught = error;
			}
			check(
				caught instanceof TypeError,
				"matching three argument adapter rejects BigInt numeric input",
			);
			output.push(globalThis.forwardTerminal([9].values(), "find", [shared], false));
		} else
			check(
				arguments.length === 2 ? owner === undefined : typeof owner === "number",
				"nested 2/3 argument contract",
			);
		collectGarbage();
		return number;
	};
	[5, 6].forEach(shared);
	check(output.join() === "10,9,10,9", "matching typed context arity fallback");
	console.log("arity", output.join());
}
function runFallbacks() {
	let calls = 0;
	function target(value) {
		return value;
	}
	const callbacks = [
		target.bind(null),
		new Proxy(target, {
			apply(fn, receiver, args) {
				calls++;
				return Reflect.apply(fn, receiver, args);
			},
		}),
		Boolean,
	];
	const output = [];
	for (const callback of callbacks) {
		globalThis.forwardTerminal([1, 2].values(), "forEach", [callback], false);
		output.push(globalThis.forwardReduce([1, 2].values(), callback, 1, true));
		output.push(globalThis.forwardTerminal([1].values(), "some", [callback], false));
	}
	const revoked = Proxy.revocable(target, {});
	revoked.revoke();
	for (const callback of [revoked.proxy, class Invalid {}]) {
		let caught;
		try {
			globalThis.forwardTerminal([1].values(), "forEach", [callback], false);
		} catch (error) {
			caught = error;
		}
		check(caught instanceof TypeError, "unsupported callbacks throw");
	}
	check(
		calls === 5 && output.join() === "1,true,1,true,true,true",
		"generic fallback behavior",
	);
	console.log("fallbacks", output.join(), calls);
}
if (mode === "all" || mode === "forEach") runForEach();
if (mode === "all" || mode === "reduce") runReduce();
if (mode === "all" || mode === "predicates") runPredicates();
if (mode === "all" || mode === "abrupt") runAbrupt();
if (mode === "all" || mode === "reentry") runReentry();
if (mode === "all" || mode === "arity") runArity();
if (mode === "all" || mode === "fallbacks") runFallbacks();
