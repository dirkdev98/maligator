"use strict";
const kind = process.env.CONSTRUCTOR_KIND || "map";
const collectGarbage =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});
function assert(value, message) {
	if (!value) throw new Error(message);
}
function construct(Base, method, getAdder, source) {
	function Derived() {}
	Derived.prototype = Object.create(Base.prototype, { [method]: { get: getAdder } });
	return Reflect.construct(Base, [source], Derived);
}
if (["map", "weakMap", "set", "weakSet"].includes(kind)) {
	const map = kind === "map" || kind === "weakMap";
	const Base = { map: Map, weakMap: WeakMap, set: Set, weakSet: WeakSet }[kind];
	const method = map ? "set" : "add";
	const first = { id: 1 };
	const second = { id: 2 };
	const third = { id: 3 };
	const entries = map
		? [
				[first, { n: 10 }],
				[second, { n: 20 }],
			]
		: [first, second];
	const log = [];
	let calls = 0;
	const source = {
		get [Symbol.iterator]() {
			collectGarbage();
			log.push("iterator");
			return function () {
				collectGarbage();
				let index = 0;
				return {
					get next() {
						collectGarbage();
						log.push("next");
						return function () {
							collectGarbage();
							return index < entries.length
								? { value: entries[index++], done: false }
								: { done: true };
						};
					},
				};
			};
		},
	};
	const result = construct(
		Base,
		method,
		function () {
			collectGarbage();
			log.push("adder");
			assert(this instanceof Base, "fresh receiver survived getter GC");
			const captured = { marker: 7 };
			return function adder(key, value) {
				collectGarbage();
				assert(this instanceof Base && captured.marker === 7, "receiver/capture root");
				assert(arguments.length === (map ? 2 : 1), "adder arity");
				calls++;
				if (calls === 1) {
					Object.defineProperty(this, method, {
						value() {
							throw new Error("reread adder");
						},
					});
					entries.push(map ? [third, { n: 30 }] : third);
					assert(new Set([4, 5]).has(5), "nested constructor");
				}
				if (map) Base.prototype.set.call(this, key, value);
				else Base.prototype.add.call(this, key);
				return { ignored: true };
			};
		},
		source,
	);
	assert(calls === 3 && result.has(third), "live traversal");
	if (map)
		assert(result.get(second).n === 20 && result.get(third).n === 30, "key/value order");
	assert(log.join(",") === "adder,iterator,next", "acquisition order");
	console.log(kind, calls, result.has(first), log.join(","));
} else if (kind === "pairs") {
	const key = {};
	const value = { n: 8 };
	const map = new Map(
		new Map([
			[key, value],
			["second", 9],
		]).entries(),
	);
	const setMap = new Map(new Set([key, value]).entries());
	const arrayMap = new Map([11, 12].entries());
	const weak = new WeakMap(new Set([key, value]).entries());
	assert(
		map.get(key) === value && setMap.get(key) === key && arrayMap.get(1) === 12,
		"pair families",
	);
	assert(weak.get(key) === key && weak.get(value) === value, "weak pair reuse");
	const source = new Map([[key, value]]);
	let calls = 0;
	const custom = construct(
		Map,
		"set",
		function () {
			return function (k, v) {
				collectGarbage();
				Map.prototype.set.call(this, k, v);
				if (++calls === 1) source.set("appended", 13);
			};
		},
		source.entries(),
	);
	assert(calls === 2 && custom.get("appended") === 13, "borrowed live custom adder");
	console.log("pairs", map.size, setMap.size, arrayMap.size, calls);
} else if (kind === "abrupt") {
	const original = { original: true };
	let closes = 0;
	const source = {
		[Symbol.iterator]() {
			return {
				next() {
					return { value: [{}, 1], done: false };
				},
				get return() {
					collectGarbage();
					closes++;
					throw new Error("close getter");
				},
			};
		},
	};
	try {
		construct(
			Map,
			"set",
			function () {
				return function () {
					collectGarbage();
					throw original;
				};
			},
			source,
		);
		throw new Error("expected adder throw");
	} catch (error) {
		assert(error === original && closes === 1, "close throw precedence");
	}
	let gets = 0;
	const values = [0];
	Object.defineProperty(values, 0, {
		get() {
			gets++;
			collectGarbage();
			throw original;
		},
	});
	const cursor = values.entries();
	Object.defineProperty(cursor, "return", {
		value() {
			closes++;
			return {};
		},
	});
	try {
		new Map(cursor);
		throw new Error("expected element throw");
	} catch (error) {
		assert(
			error === original && gets === 1 && closes === 1,
			"step abrupt cannot replay or close",
		);
	}
	assert(cursor.next().done, "cursor advanced once");
	let weakClose = 0;
	const invalid = {
		[Symbol.iterator]() {
			return {
				next() {
					return { value: [1, 2], done: false };
				},
				return() {
					weakClose++;
					return {};
				},
			};
		},
	};
	try {
		new WeakMap(invalid);
		throw new Error("weak primitive");
	} catch (error) {
		assert(error instanceof TypeError && weakClose === 1, "weak key close");
	}
	for (const Base of [WeakMap, WeakSet]) {
		const registered = Symbol.for("constructor-weak-key");
		try {
			new Base(Base === WeakMap ? [[registered, 3]] : [registered]);
			throw new Error("registered symbol accepted");
		} catch (error) {
			assert(error instanceof TypeError, "registered weak symbol");
		}
		const local = Symbol("constructor-weak-key");
		const collection = new Base(Base === WeakMap ? [[local, 3]] : [local]);
		collectGarbage();
		assert(collection.has(local), "unregistered weak symbol");
	}
	console.log("abrupt", closes, gets, weakClose);
} else if (kind === "acquisition") {
	const original = { acquisition: true };
	let iteratorGets = 0;
	let closeGets = 0;
	for (const Base of [Map, WeakMap, Set, WeakSet]) {
		const method = Base === Map || Base === WeakMap ? "set" : "add";
		const source = {
			get [Symbol.iterator]() {
				iteratorGets++;
				collectGarbage();
				return function () {
					return {
						get next() {
							collectGarbage();
							throw original;
						},
						get return() {
							closeGets++;
							throw new Error("must not close acquisition");
						},
					};
				};
			},
		};
		try {
			construct(
				Base,
				method,
				function () {
					collectGarbage();
					throw original;
				},
				source,
			);
			throw new Error("missing getter throw");
		} catch (error) {
			assert(error === original, "adder getter completion");
		}
		try {
			construct(
				Base,
				method,
				function () {
					return function () {};
				},
				source,
			);
			throw new Error("missing next getter throw");
		} catch (error) {
			assert(error === original, "iterator acquisition completion");
		}
	}
	assert(iteratorGets === 4 && closeGets === 0, "acquisition order and cleanup");
	console.log("acquisition", iteratorGets, closeGets);
} else if (kind === "outer") {
	let inner = 0;
	function shared(key, value, collection) {
		collectGarbage();
		if (arguments.length === 3) {
			assert(collection[0] === 1, "outer callback arguments");
			const map = construct(
				Map,
				"set",
				function () {
					return shared;
				},
				[[{ n: 4 }, 9]],
			);
			const set = construct(
				Set,
				"add",
				function () {
					return shared;
				},
				[{ n: 5 }],
			);
			assert(map.size === 1 && set.size === 1, "nested matching callback");
		} else if (arguments.length === 2) {
			inner++;
			Map.prototype.set.call(this, key, value);
		} else {
			assert(arguments.length === 1, "Set callback arity");
			inner++;
			Set.prototype.add.call(this, key);
		}
	}
	[1].forEach(shared);
	assert(inner === 2, "matching context restored");
	console.log("outer", inner);
} else if (kind === "fallbacks") {
	const key = {};
	let calls = 0;
	const target = function (k, v) {
		calls++;
		Map.prototype.set.call(this, k, v);
	};
	const proxy = new Proxy(target, {
		apply(fn, receiver, args) {
			collectGarbage();
			return Reflect.apply(fn, receiver, args);
		},
	});
	const mapped = construct(
		Map,
		"set",
		function () {
			return proxy;
		},
		[[key, 4]],
	);
	const receiver = new Set();
	const bound = Set.prototype.add.bind(receiver);
	const separate = construct(
		Set,
		"add",
		function () {
			return bound;
		},
		[5, 6],
	);
	assert(
		mapped.get(key) === 4 && calls === 1 && receiver.size === 2 && separate.size === 0,
		"unsupported callback fallback",
	);
	let acquired = 0;
	const source = {
		get [Symbol.iterator]() {
			acquired++;
			return function () {
				return {
					next() {
						return { done: true };
					},
				};
			};
		},
	};
	try {
		construct(
			Map,
			"set",
			function () {
				collectGarbage();
				return 1;
			},
			source,
		);
	} catch (error) {
		assert(error instanceof TypeError, "noncallable adder");
	}
	assert(acquired === 0, "noncallable before iterator");
	let wrongBrandClosed = 0;
	const iterator = [[key, 8]][Symbol.iterator]();
	Object.defineProperty(iterator, "return", {
		value() {
			wrongBrandClosed++;
			return {};
		},
	});
	try {
		construct(
			Map,
			"set",
			function () {
				return Set.prototype.add;
			},
			iterator,
		);
		throw new Error("wrong family accepted");
	} catch (error) {
		assert(
			error instanceof TypeError && wrongBrandClosed === 1,
			"borrowed adder brand/close",
		);
	}
	console.log("fallbacks", calls, receiver.size, separate.size, acquired);
} else throw new Error("unknown constructor mode");
