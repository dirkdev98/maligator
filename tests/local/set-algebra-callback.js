"use strict";
const kind = process.env.SET_ALGEBRA_KIND || "intersection";
const collectGarbage =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});
function assert(value, message) {
	if (!value) throw new Error(message);
}
function otherRecord(has, size = 100) {
	return {
		size,
		has,
		keys() {
			throw new Error("unexpected keys call");
		},
	};
}
if (["intersection", "difference", "isSubsetOf", "isDisjointFrom"].includes(kind)) {
	const source = new Set([1, 2, 3]);
	const order = [];
	const calls = [];
	const other = {
		get size() {
			order.push("size");
			return {
				valueOf() {
					collectGarbage();
					order.push("number");
					return 100.9;
				},
			};
		},
		get has() {
			order.push("has");
			const captured = { token: 17 };
			return function has(value, missing = 42) {
				collectGarbage();
				assert(
					this === other &&
						arguments.length === 1 &&
						missing === 42 &&
						captured.token === 17,
					"boxed callback contract",
				);
				calls.push(value);
				if (calls.length === 1) {
					source.delete(1);
					source.add(4);
					source.add(1);
				}
				if (kind === "isDisjointFrom" || (kind !== "isSubsetOf" && value % 2 === 0))
					return 0;
				return {
					valueOf() {
						throw new Error("ToBoolean must not coerce");
					},
					toString() {
						throw new Error("ToBoolean must not stringify");
					},
				};
			};
		},
		get keys() {
			collectGarbage();
			order.push("keys");
			Object.defineProperty(this, "has", {
				value() {
					throw new Error("reread has");
				},
			});
			return function () {
				throw new Error("unused keys");
			};
		},
	};
	const result = source[kind](other);
	assert(order.join(",") === "size,number,has,keys", "GetSetRecord observation order");
	assert(
		calls.join(",") === (kind === "difference" ? "1,2,3" : "1,2,3,4,1"),
		"live receiver versus copied worklist",
	);
	if (kind === "intersection")
		assert([...result].join(",") === "1,3", "intersection order/dedupe");
	else if (kind === "difference")
		assert([...result].join(",") === "2", "difference copy");
	else assert(result === true, "predicate result");
	console.log(
		kind,
		calls.join(","),
		typeof result === "boolean" ? result : [...result].join(","),
	);
} else if (kind === "keys") {
	let hasCalls = 0;
	let keyCalls = 0;
	let closes = 0;
	const source = new Set([1, 2, 3]);
	const other = {
		size: 1,
		has() {
			hasCalls++;
			throw new Error("unused has");
		},
		keys() {
			assert(this === other && arguments.length === 0, "keys receiver/arity");
			keyCalls++;
			let index = 0;
			return {
				next() {
					collectGarbage();
					return index++ === 0 ? { value: 2, done: false } : { done: true };
				},
				return() {
					closes++;
					return {};
				},
			};
		},
	};
	assert([...source.intersection(other)].join(",") === "2", "keys intersection");
	assert([...source.difference(other)].join(",") === "1,3", "keys difference");
	assert(
		source.isDisjointFrom(other) === false && source.isSupersetOf(other),
		"keys predicates",
	);
	assert([...source.union(other)].join(",") === "1,2,3", "keys union");
	assert(
		[...source.symmetricDifference(other)].join(",") === "1,3",
		"keys symmetricDifference",
	);
	assert(
		hasCalls === 0 && keyCalls === 6 && closes === 1,
		"keys-only execution and early close",
	);
	console.log("keys", hasCalls, keyCalls, closes);
} else if (kind === "values") {
	const object = { marker: 7 };
	const symbol = Symbol("key");
	const values = [object, symbol, "text", NaN, -0];
	let calls = 0;
	const other = otherRecord(function (value) {
		collectGarbage();
		assert(this === other && arguments.length === 1, "value receiver/arity");
		calls++;
		return value === object || value === symbol || Number.isNaN(value);
	});
	const result = new Set(values).intersection(other);
	assert(
		result.size === 3 &&
			result.has(object) &&
			result.has(symbol) &&
			result.has(NaN) &&
			calls === 5,
		"boxed value identities",
	);
	console.log("values", result.size, calls);
} else if (kind === "abrupt") {
	const marker = { thrown: true };
	let calls = 0;
	let keys = 0;
	const source = new Set([1, 2, 3]);
	const other = {
		size: 100,
		has(value) {
			collectGarbage();
			calls++;
			if (value === 2) throw marker;
			return true;
		},
		keys() {
			keys++;
			throw new Error("must not acquire iterator");
		},
	};
	try {
		source.intersection(other);
		throw new Error("expected callback throw");
	} catch (error) {
		assert(
			error === marker && calls === 2 && keys === 0,
			"throw unchanged without IteratorClose",
		);
	}
	assert(
		source.size === 3 && source.delete(1) && source.add(4).has(4),
		"pin released on throw",
	);
	const nested = otherRecord(function () {
		collectGarbage();
		return true;
	});
	const reentrant = otherRecord(function () {
		assert(new Set([8]).isSubsetOf(nested), "nested callback");
		return false;
	});
	assert(new Set([1, 2]).isDisjointFrom(reentrant), "outer restored after nested call");
	console.log("abrupt", calls, keys, source.size);
} else if (kind === "acquisition") {
	const marker = {};
	const log = [];
	for (const stage of ["number", "has", "keys"]) {
		const other = {
			get size() {
				log.push("size");
				return {
					valueOf() {
						collectGarbage();
						log.push("number");
						if (stage === "number") throw marker;
						return 2;
					},
				};
			},
			get has() {
				collectGarbage();
				log.push("has");
				if (stage === "has") throw marker;
				return function () {
					throw new Error("must not call");
				};
			},
			get keys() {
				collectGarbage();
				log.push("keys");
				throw marker;
			},
		};
		try {
			new Set([1]).isSubsetOf(other);
			throw new Error("missing acquisition error");
		} catch (error) {
			assert(error === marker, "acquisition completion");
		}
	}
	assert(
		log.join(",") === "size,number,size,number,has,size,number,has,keys",
		"abrupt acquisition order",
	);
	for (const [size, errorType] of [
		[NaN, TypeError],
		[-1, RangeError],
		[1n, TypeError],
		[Symbol("size"), TypeError],
	]) {
		try {
			new Set([1]).intersection({
				size,
				get has() {
					throw new Error("read after invalid size");
				},
			});
			throw new Error("invalid size accepted");
		} catch (error) {
			assert(error instanceof errorType, "size conversion error");
		}
	}
	console.log("acquisition", log.length);
} else if (kind === "fallbacks") {
	const keys = new Set([1, 2]);
	const bound = keys.has.bind(keys);
	const proxy = new Proxy(
		function (value) {
			return value === 2;
		},
		{
			apply(target, receiver, args) {
				collectGarbage();
				return Reflect.apply(target, receiver, args);
			},
		},
	);
	assert(new Set([1, 2]).isSubsetOf(otherRecord(bound)), "bound has");
	assert(
		[...new Set([1, 2]).intersection(otherRecord(proxy))].join(",") === "2",
		"proxy has",
	);
	assert(new Set([1]).isSubsetOf(new Set([1, 2])), "native set fast path");
	console.log("fallbacks", keys.size);
} else if (kind === "outer") {
	let inner = 0;
	let other;
	function shared(value, index, array) {
		collectGarbage();
		if (arguments.length === 3) {
			assert(array[index] === value, "outer arguments");
			assert(new Set([7, 8]).isSubsetOf(other), "matching outer context");
		} else {
			assert(this === other && arguments.length === 1, "inner arguments/receiver");
			inner++;
			return true;
		}
	}
	other = otherRecord(shared);
	[1].forEach(shared);
	assert(inner === 2, "matching callback count");
	console.log("outer", inner);
} else throw new Error("unknown Set algebra mode");
