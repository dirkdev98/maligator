const mode = process.env.FORWARDED_SORT_KIND || "all";
const collectGarbage = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});
function check(value, message) {
	if (!value) throw new Error(message);
}
function forwardSort(receiver, callback) {
	return receiver.sort(callback);
}
function forwardCopy(receiver, callbacks, select) {
	let callback = callbacks[0];
	if (select) callback = callbacks[1];
	return receiver.toSorted(callback);
}
globalThis.forwardSort = forwardSort;
globalThis.forwardCopy = forwardCopy;

function comparators() {
	function make(direction) {
		let calls = 0;
		return function compare(left, right, missing = "default", ...rest) {
			check(this === globalThis, "sloppy comparator this");
			check(
				arguments.length === 2 && missing === "default" && rest.length === 0,
				"comparator arguments",
			);
			calls++;
			collectGarbage();
			check(calls > 0, "live capture");
			return (left < right ? -1 : left > right ? 1 : 0) * direction;
		};
	}
	return [make(1), make(-1)];
}
function runArray() {
	const callbacks = comparators();
	const input = [3, undefined, , 1, 2];
	const copy = globalThis.forwardCopy(input, callbacks, false);
	check(
		globalThis.forwardCopy(input, callbacks, true).join(",") === "3,2,1,,",
		"phi callback selection",
	);
	check(copy.length === 5 && 4 in copy && !(2 in input), "copy holes");
	check(
		globalThis.forwardSort(input, callbacks[1]) === input && !(4 in input),
		"sort identity and holes",
	);
	const records = [
		{ key: 2, id: "a" },
		{ key: 1, id: "b" },
		{ key: 2, id: "c" },
	];
	const sorted = globalThis.forwardCopy(
		records,
		[
			function recordOrder(a, b) {
				"use strict";
				check(this === undefined && arguments.length === 2, "strict comparator");
				collectGarbage();
				return a.key - b.key;
			},
		],
		false,
	);
	check(sorted[1] === records[0] && sorted[2] === records[2], "stable object identity");
	const log = [];
	const arrayLike = new Proxy(
		{ 0: "c", 1: "a", 2: "b", length: 3, sort: Array.prototype.sort },
		{
			get(target, key) {
				if (key === "0" || key === "1" || key === "2") log.push("get" + key);
				return target[key];
			},
			set(target, key, value) {
				log.push("set" + key);
				target[key] = value;
				return true;
			},
		},
	);
	globalThis.forwardSort(arrayLike, callbacks[0]);
	check(
		log.join(",") === "get0,get1,get2,set0,set1,set2",
		"collection and writeback order",
	);
	let coercions = 0;
	globalThis.forwardSort([2, 1], function coercingOrder() {
		return {
			valueOf() {
				coercions++;
				collectGarbage();
				return -1;
			},
		};
	});
	check(coercions === 1, "result coercion once");
	for (const value of [1n, Symbol("result")]) {
		let calls = 0;
		let caught;
		try {
			globalThis.forwardSort([2, 1], function badResult() {
				calls++;
				return value;
			});
		} catch (error) {
			caught = error;
		}
		check(caught instanceof TypeError && calls === 1, "throw without replay");
	}
	const changed = [2, 1];
	Object.defineProperty(changed, "sort", {
		value(callback) {
			return callback === callbacks[0] ? "replacement" : "bad";
		},
	});
	check(
		globalThis.forwardSort(changed, callbacks[0]) === "replacement",
		"replaced method",
	);
	console.log(
		"array",
		copy.join(","),
		input.join(","),
		sorted.map((value) => value.id).join(""),
		arrayLike[0] + arrayLike[1] + arrayLike[2],
	);
}
function runTyped(bigint) {
	const callbacks = comparators();
	const constructors = bigint
		? [BigInt64Array, BigUint64Array]
		: [
				Int8Array,
				Uint8Array,
				Uint8ClampedArray,
				Int16Array,
				Uint16Array,
				Int32Array,
				Uint32Array,
				Float32Array,
				Float64Array,
			];
	const outputs = [];
	for (const Ctor of constructors) {
		const values = new Ctor(bigint ? [3n, 1n, 2n] : [3, 1, 2]);
		const copy = globalThis.forwardCopy(values, callbacks, false);
		check(
			copy instanceof Ctor && copy !== values && values.join(",") === "3,1,2",
			"typed copy kind",
		);
		check(globalThis.forwardSort(values, callbacks[1]) === values, "typed sort identity");
		check(copy.join(",") === "1,2,3" && values.join(",") === "3,2,1", "typed ordering");
		outputs.push(copy.join(","));
	}
	const source = bigint ? new BigInt64Array([3n, 1n, 2n]) : new Float64Array([3, 1, 2]);
	let mutated = false;
	const copied = globalThis.forwardCopy(
		source,
		[
			function mutateSource(a, b) {
				if (!mutated) {
					mutated = true;
					source[0] = bigint ? 9n : 9;
					collectGarbage();
				}
				return a < b ? -1 : a > b ? 1 : 0;
			},
		],
		false,
	);
	check(source[0] === (bigint ? 9n : 9) && copied.join(",") === "1,2,3", "copy snapshot");
	if (bigint) {
		for (const result of [1n, Symbol("order")]) {
			let calls = 0;
			let caught;
			try {
				globalThis.forwardSort(new BigInt64Array([2n, 1n]), function invalidOrder() {
					calls++;
					return result;
				});
			} catch (error) {
				caught = error;
			}
			check(
				caught instanceof TypeError && calls === 1,
				"BigInt comparison result throw once",
			);
		}
		const marker = {};
		let coercions = 0;
		let caught;
		try {
			globalThis.forwardCopy(
				source,
				[
					function throwingCoercion() {
						return {
							valueOf() {
								coercions++;
								collectGarbage();
								throw marker;
							},
						};
					},
				],
				false,
			);
		} catch (error) {
			caught = error;
		}
		check(caught === marker && coercions === 1, "BigInt result coercion without replay");
	}
	if (!bigint && typeof SharedArrayBuffer === "function") {
		const shared = new Int32Array(new SharedArrayBuffer(12));
		shared.set([3, 1, 2]);
		check(
			globalThis.forwardSort(shared, callbacks[0]).join(",") === "1,2,3",
			"shared sort",
		);
	}
	if (!bigint) {
		const buffer = new ArrayBuffer(24, { maxByteLength: 48 });
		const view = new Float64Array(buffer);
		view.set([3, 1, 2]);
		let resized = false;
		globalThis.forwardSort(view, function resize(a, b) {
			if (!resized) {
				resized = true;
				buffer.resize(8);
			}
			return a - b;
		});
		check(view.length === 1 && view[0] === 1, "resize during sort");
		const detachable = new Float64Array([3, 1, 2]);
		let detached = false;
		globalThis.forwardSort(detachable, function detach(a, b) {
			if (!detached) {
				detached = true;
				detachable.buffer.transfer();
			}
			return a - b;
		});
		check(detachable.length === 0, "detach during sort");
	}
	console.log(bigint ? "bigint" : "typed", outputs.join("|"), copied.join(","));
}
function runArity() {
	let nested = 0;
	const shared = function shared(value, index, owner) {
		if (arguments.length === 3) {
			check(owner !== undefined, "outer owner");
			check(
				globalThis.forwardSort([3, 1, 2], shared).join(",") === "1,2,3",
				"matching array context",
			);
			check(
				globalThis.forwardSort(new Int32Array([3, 1, 2]), shared).join(",") === "1,2,3",
				"matching typed context",
			);
			nested++;
		} else check(arguments.length === 2 && owner === undefined, "nested arity fallback");
		collectGarbage();
		let offset = index;
		for (let step = 0; step < 2; step++) offset += index;
		return value - offset / 3;
	};
	[4, 5].forEach(shared);
	check(nested === 2, "outer continuation");
	return nested;
}
function runReentry() {
	const nested = runArity();
	let calls = 0;
	function growing(a, b) {
		if (calls++ === 0) {
			let source = "return [";
			for (let i = 0; i < 80; i++)
				source += (i ? "," : "") + "function(){return " + i + ";}";
			const functions = Function(source + "]; ")();
			check(functions[79]() === 79, "function table growth");
			const inner = globalThis.forwardCopy(
				new BigInt64Array([2n, 1n]),
				comparators(),
				false,
			);
			check(inner.join(",") === "1,2", "nested different comparator");
		}
		collectGarbage();
		return a - b;
	}
	check(
		globalThis.forwardSort([4, 3, 2, 1], growing).join(",") === "1,2,3,4" && calls > 1,
		"growth continuation",
	);
	const marker = {};
	let caught;
	try {
		globalThis.forwardSort([2, 1], function throwing() {
			throw marker;
		});
	} catch (error) {
		caught = error;
	}
	check(caught === marker, "throw identity");
	check(
		globalThis.forwardCopy([2, 1], comparators(), false).join(",") === "1,2",
		"restored after throw",
	);
	console.log("reentry", nested);
}
function runFallbacks() {
	check(
		globalThis.forwardSort([10, 2], undefined).join(",") === "10,2",
		"default Array order",
	);
	check(
		globalThis.forwardCopy(new Int32Array([10, 2]), [undefined], false).join(",") ===
			"2,10",
		"default TypedArray order",
	);
	function compare(a, b) {
		return a - b;
	}
	let proxyCalls = 0;
	const proxy = new Proxy(compare, {
		apply(target, receiver, args) {
			proxyCalls++;
			return Reflect.apply(target, receiver, args);
		},
	});
	for (const callback of [
		compare.bind(null),
		proxy,
		Math.min,
		Function("a", "b", "return a-b"),
		async function asyncCompare() {},
		function* generatorCompare() {},
	]) {
		globalThis.forwardSort([2, 1], callback);
		globalThis.forwardCopy(new Int32Array([2, 1]), [callback], false);
	}
	check(proxyCalls === 2, "proxy invocation");
	let brandError;
	try {
		globalThis.forwardSort({ sort: Int32Array.prototype.sort }, compare);
	} catch (error) {
		brandError = error;
	}
	check(brandError instanceof TypeError, "borrowed method brand error");
	const revoked = Proxy.revocable(compare, {});
	revoked.revoke();
	for (const callback of [revoked.proxy, class Invalid {}]) {
		let caught;
		try {
			globalThis.forwardSort([2, 1], callback);
		} catch (error) {
			caught = error;
		}
		check(caught instanceof TypeError, "unsupported callable throw");
	}
	console.log("fallbacks", proxyCalls);
}
if (mode === "arity") console.log("arity", runArity());
if (mode === "all" || mode === "array") runArray();
if (mode === "all" || mode === "typed") runTyped(false);
if (mode === "all" || mode === "bigint") runTyped(true);
if (mode === "all" || mode === "reentry") runReentry();
if (mode === "all" || mode === "fallbacks") runFallbacks();
