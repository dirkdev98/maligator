const mode = process.env.FORWARDED_CALLBACK_KIND || "all";
const collectGarbage =
	globalThis.__mal_collect_garbage ?? globalThis.gc ?? globalThis.$262?.gc ?? (() => {});

function check(value, message) {
	if (!value) throw new Error(message);
}
function forwardEach(receiver, callbacks, select, context) {
	let callback = callbacks[0];
	if (select) callback = callbacks[1];
	return receiver.forEach(callback, context);
}
function forwardMap(receiver, callback, context) {
	return receiver.map(callback, context);
}
function forwardReduce(receiver, callback, initial) {
	return receiver.reduce(callback, initial);
}
function forwardRight(receiver, callback, initial) {
	return receiver.reduceRight(callback, initial);
}
globalThis.forwardEach = forwardEach;
globalThis.forwardMap = forwardMap;
globalThis.forwardReduce = forwardReduce;
globalThis.forwardRight = forwardRight;

function visitors(receiver, log, mutate) {
	let capture = 2;
	function make(label) {
		return function visit(value, key, owner, missing = "default", ...rest) {
			check(owner === receiver && arguments.length === 3, "callback arguments");
			check(missing === "default" && rest.length === 0, "missing arguments");
			check(typeof this === "object" && this.valueOf() === 17, "sloppy this boxing");
			log.push(label + ":" + String(value) + ":" + String(key) + ":" + capture++);
			mutate(value, key, owner);
			collectGarbage();
		};
	}
	return [make("a"), make("b")];
}
function runArray() {
	const values = [1, , 3, 4];
	const log = [];
	const callbacks = visitors(values, log, function mutate(value, key, owner) {
		if (key === 0) {
			owner[1] = 2;
			delete owner[2];
			owner.push(99);
		}
	});
	check(
		globalThis.forwardEach(values, callbacks, false, 17) === undefined,
		"forEach result",
	);
	values.length = 2;
	globalThis.forwardEach(values, callbacks, true, 17);
	let speciesReads = 0;
	Object.defineProperty(values, "constructor", {
		get() {
			speciesReads++;
			collectGarbage();
			return Array;
		},
	});
	const mapped = globalThis.forwardMap(
		values,
		function mapValue(value, key, owner) {
			"use strict";
			check(
				this === 23 && owner === values && arguments.length === 3,
				"strict map arguments",
			);
			check(speciesReads === 1, "species precedes callback");
			return { value: value + key };
		},
		23,
	);
	console.log("array", log.join("|"), mapped[0].value, mapped[1].value);
	const aliased = globalThis.forwardMap([4, 5], function mappedArguments(value) {
		arguments[0] = value + 10;
		return value;
	});
	check(aliased.join(",") === "14,15", "sloppy mapped arguments");
	let factor = 2;
	function reduceValue(acc, value, index, owner) {
		"use strict";
		check(
			this === undefined && owner === values && arguments.length === 4,
			"reduce arguments",
		);
		factor++;
		collectGarbage();
		return acc + value * factor + index;
	}
	console.log(
		"reductions",
		globalThis.forwardReduce(values, reduceValue, "x"),
		globalThis.forwardRight(values, reduceValue, 0),
	);
}
function runTyped() {
	const values = new Int16Array([1, 2, 3]);
	const log = [];
	const callbacks = visitors(values, log, function mutate(value, key, owner) {
		if (key === 0) owner[1] = -7;
	});
	globalThis.forwardEach(values, callbacks, true, 17);
	const big = new BigInt64Array([1n, 2n, 3n]);
	const mapped = globalThis.forwardMap(big, function mapBig(value, key, owner) {
		check(
			owner === big && typeof value === "bigint" && arguments.length === 3,
			"boxed BigInt",
		);
		return value + BigInt(key);
	});
	console.log(
		"typed",
		log.join("|"),
		mapped.join(","),
		String(
			globalThis.forwardReduce(
				big,
				function sum(acc, value) {
					return acc + value;
				},
				0n,
			),
		),
	);
	const detached = new Int16Array([1, 2, 3]);
	const detachedLog = [];
	globalThis.forwardEach(
		detached,
		[
			function detach(value, index, owner) {
				check(owner === detached, "detached receiver identity");
				detachedLog.push(String(value) + ":" + index);
				if (index === 0) owner.buffer.transfer();
				collectGarbage();
			},
		],
		false,
	);
	const buffer = new ArrayBuffer(6, { maxByteLength: 12 });
	const resized = new Int16Array(buffer);
	resized.set([4, 5, 6]);
	const resizedLog = [];
	globalThis.forwardEach(
		resized,
		[
			function resize(value, index) {
				resizedLog.push(String(value) + ":" + index);
				if (index === 0) buffer.resize(2);
			},
		],
		false,
	);
	let conversions = 0;
	const clamped = globalThis.forwardMap(
		new Uint8ClampedArray([0, 2, 255]),
		function convert(value) {
			return {
				valueOf() {
					conversions++;
					collectGarbage();
					return value + 0.5;
				},
			};
		},
	);
	check(
		conversions === 3 && clamped.join(",") === "0,2,255",
		"owning typed conversion once",
	);
	console.log("typed-live", detachedLog.join("|"), resizedLog.join("|"));
}
function runMap() {
	const key = {
		toString() {
			return "object-key";
		},
	};
	const values = new Map([
		[key, "one"],
		["gone", "two"],
	]);
	const log = [];
	const callbacks = visitors(values, log, function mutate(value, current, owner) {
		if (current === key) {
			owner.delete("gone");
			owner.set("new", "three");
		}
		if (current === "new") {
			owner.clear();
			owner.set("last", "four");
		}
	});
	globalThis.forwardEach(values, callbacks, false, 17);
	globalThis.forwardEach(values, callbacks, true, 17);
	console.log("map", log.join("|"));
}
function runSet() {
	const values = new Set(["one", "gone"]);
	const log = [];
	let reinserted = false;
	const callbacks = visitors(values, log, function mutate(value, key, owner) {
		check(value === key, "Set duplicate argument");
		if (value === "one" && !reinserted) {
			reinserted = true;
			owner.delete("gone");
			owner.delete("one");
			owner.add("one");
			owner.add("last");
		}
	});
	globalThis.forwardEach(values, callbacks, true, 17);
	console.log("set", log.join("|"));
}
function runReentry() {
	const log = [];
	const marker = {};
	const outer = [1, 2, 3];
	const callback = function visit(value) {
		log.push(value);
		if (value === 1) {
			globalThis.forwardEach(
				new Set([8, 9]),
				[
					function nested(inner) {
						log.push(inner);
						collectGarbage();
					},
				],
				false,
			);
		}
		if (value === 2) throw marker;
	};
	try {
		globalThis.forwardEach(outer, [callback], false);
		throw new Error("missing throw");
	} catch (error) {
		check(error === marker, "throw identity");
	}
	globalThis.forwardEach(
		[4],
		[
			function recovery(value) {
				log.push(value);
			},
		],
		false,
	);
	console.log("reentry", log.join(","));
}
function runFallbacks() {
	let calls = 0;
	function target(value) {
		calls++;
		return this.base + value;
	}
	const bound = target.bind({ base: 10 });
	const proxy = new Proxy(target, {
		apply(fn, context, args) {
			calls++;
			return Reflect.apply(fn, { base: 20 }, args);
		},
	});
	console.log(
		"fallbacks",
		globalThis.forwardMap([1, 2], bound).join(","),
		globalThis.forwardMap([3], proxy).join(","),
		globalThis.forwardMap([-4], Math.abs).join(","),
	);
	class NotCallable {}
	check(globalThis.forwardMap([], NotCallable).length === 0, "empty class callback");
	try {
		globalThis.forwardMap([1], NotCallable);
		throw new Error("missing class throw");
	} catch (error) {
		check(error instanceof TypeError, "class invocation error");
	}
	try {
		globalThis.forwardMap([], null);
		throw new Error("missing noncallable throw");
	} catch (error) {
		check(error instanceof TypeError, "empty receiver validates callback");
	}
	const marker = {};
	const receiver = {
		map: Array.prototype.map,
		get length() {
			throw marker;
		},
	};
	try {
		globalThis.forwardMap(receiver, null);
		throw new Error("missing getter throw");
	} catch (error) {
		check(error === marker, "length precedes callback validation");
	}
	const replaced = {
		map(callback) {
			check(callback === bound, "replacement callback");
			return "replacement";
		},
	};
	check(
		globalThis.forwardMap(replaced, bound) === "replacement",
		"method identity fallback",
	);
	const wrong = { map: Set.prototype.forEach };
	try {
		globalThis.forwardMap(wrong, bound);
		throw new Error("missing brand throw");
	} catch (error) {
		check(error instanceof TypeError, "wrong family brand");
	}
	const revoked = Proxy.revocable(target, {});
	revoked.revoke();
	check(globalThis.forwardMap([], revoked.proxy).length === 0, "empty revoked callback");
	try {
		globalThis.forwardMap([1], revoked.proxy);
		throw new Error("missing proxy throw");
	} catch (error) {
		check(error instanceof TypeError, "revoked invocation error");
	}
	const generator = globalThis.forwardMap([5], function* generator(value) {
		yield value + 1;
	});
	check(generator[0].next().value === 6, "generator fallback");
	const promises = globalThis.forwardMap([7], async function asynchronous(value) {
		return value + 1;
	});
	check(promises[0] instanceof Promise, "async fallback");
	console.log("fallback-count", calls);
}

if (mode === "all" || mode === "array") runArray();
if (mode === "all" || mode === "typed") runTyped();
if (mode === "all" || mode === "map") runMap();
if (mode === "all" || mode === "set") runSet();
if (mode === "all" || mode === "reentry") runReentry();
if (mode === "all" || mode === "fallbacks") runFallbacks();
