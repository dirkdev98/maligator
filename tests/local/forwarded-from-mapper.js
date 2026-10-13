const mode = process.env.FROM_KIND || "all";
const collectGarbage = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});
function check(value, message) {
	if (!value) throw new Error(message);
}
function forwardArray(source, callbacks, pick, thisArg, constructor = Array) {
	let callback = callbacks[0];
	if (pick) callback = callbacks[1];
	return Array.from.call(constructor, source, callback, thisArg);
}
function forwardTyped(source, callbacks, pick, thisArg, constructor = Float64Array) {
	let callback = callbacks[0];
	if (pick) callback = callbacks[1];
	return Float64Array.from.call(constructor, source, callback, thisArg);
}
globalThis.forwardArray = forwardArray;
globalThis.forwardTyped = forwardTyped;
function iterable(values, log, close) {
	return {
		get [Symbol.iterator]() {
			log.push("iterator-get");
			return function () {
				log.push("iterator-call");
				let index = 0;
				return {
					next() {
						log.push("next" + index);
						collectGarbage();
						return index < values.length
							? { value: values[index++], done: false }
							: { done: true };
					},
					get return() {
						log.push("return-get");
						return close;
					},
				};
			};
		},
	};
}
function runArrayIterable() {
	const log = [];
	const context = { offset: 4 };
	function Result() {
		log.push("construct" + arguments.length);
		const result = {};
		Object.defineProperty(result, "length", {
			set(value) {
				log.push("length" + value);
			},
		});
		return new Proxy(result, {
			defineProperty(target, key, descriptor) {
				log.push("define" + key);
				collectGarbage();
				return Reflect.defineProperty(target, key, descriptor);
			},
		});
	}
	const result = globalThis.forwardArray(
		iterable([2, 3], log),
		[
			function map(value, index, missing = 9, ...rest) {
				check(
					this === context &&
						arguments.length === 2 &&
						missing === 9 &&
						rest.length === 0,
					"array iterable arguments",
				);
				log.push("map" + index);
				collectGarbage();
				return { value: value + index + this.offset };
			},
		],
		false,
		context,
		Result,
	);
	check(result[0].value === 6 && result[1].value === 8, "constructed array result");
	check(
		log.join() ===
			"iterator-get,construct0,iterator-call,next0,map0,define0,next1,map1,define1,next2,length2",
		"array iterable order",
	);
	const holes = globalThis.forwardArray(
		[, 3, ,],
		[
			function holes(value, index) {
				return value === undefined ? "hole" + index : value;
			},
		],
		false,
	);
	check(holes.join() === "hole0,3,hole2", "holes become undefined");
	const marker = { marker: true };
	const closes = [];
	let calls = 0;
	let caught;
	try {
		globalThis.forwardArray(
			iterable([1, 2], closes, function close() {
				closes.push("close");
				throw new Error("close");
			}),
			[
				function fail() {
					calls++;
					throw marker;
				},
			],
			false,
		);
	} catch (error) {
		caught = error;
	}
	check(
		caught === marker &&
			calls === 1 &&
			closes.join() === "iterator-get,iterator-call,next0,return-get,close",
		"mapper throw wins iterator close throw",
	);
	let closeCalls = 0;
	function Refused() {
		return new Proxy(
			{},
			{
				defineProperty() {
					return false;
				},
			},
		);
	}
	try {
		globalThis.forwardArray(
			iterable([1], [], function close() {
				closeCalls++;
				return {};
			}),
			[
				function identity(value) {
					return value;
				},
			],
			false,
			undefined,
			Refused,
		);
	} catch (error) {
		caught = error;
	}
	check(
		caught instanceof TypeError && closeCalls === 1,
		"property failure closes iterator",
	);
	console.log("array-iter", log.join(), holes.join(), calls, closeCalls);
}
function runArrayLike() {
	const log = [];
	const source = {
		get [Symbol.iterator]() {
			log.push("iterator");
			return undefined;
		},
		get length() {
			log.push("length");
			return 3;
		},
		get 0() {
			log.push("get0");
			this[1] = 7;
			return 2;
		},
		2: 4,
	};
	function Result(length) {
		log.push("construct" + length);
		return {};
	}
	const result = globalThis.forwardArray(
		source,
		[
			function map(value, index) {
				"use strict";
				check(this === 11 && arguments.length === 2, "strict thisArg and two args");
				log.push("map" + index);
				if (index === 0) source[2] = 9;
				collectGarbage();
				return { value: value + index };
			},
		],
		false,
		11,
		Result,
	);
	check(
		result.length === 3 &&
			result[0].value === 2 &&
			result[1].value === 8 &&
			result[2].value === 11,
		"array-like live reads",
	);
	check(
		log.join() === "iterator,length,construct3,get0,map0,map1,map2",
		"array-like order",
	);
	const sloppy = globalThis.forwardArray(
		{ 0: 2, length: 1 },
		[
			function boxed(value) {
				check(typeof this === "object" && this.valueOf() === 7, "sloppy this boxing");
				return value;
			},
		],
		false,
		7,
	);
	const unicode = globalThis.forwardArray(
		"😀a",
		[
			function point(value, index) {
				return value + index;
			},
		],
		false,
	);
	check(unicode.join() === "😀0,a1", "string iterator code points");
	let calls = 0;
	const marker = {};
	let caught;
	try {
		globalThis.forwardArray(
			{
				length: 2,
				get 0() {
					throw marker;
				},
			},
			[
				function unreachable() {
					calls++;
				},
			],
			false,
		);
	} catch (error) {
		caught = error;
	}
	check(caught === marker && calls === 0, "index getter throws before mapper");
	function make(delta) {
		return function closure(value, index) {
			return value + index + delta;
		};
	}
	const closures = [make(1), make(9)];
	check(
		globalThis.forwardArray([2, 3], closures, true).join() === "11,13",
		"phi closure environment",
	);
	console.log("array-like", log.join(), result[2].value, sloppy.join(), unicode.join());
}
function runTypedIterable() {
	const log = [];
	const values = [2.5, 3.5, 260];
	const context = { delta: 0 };
	function Result(length) {
		log.push("construct" + length);
		collectGarbage();
		return new Uint8ClampedArray(length);
	}
	const result = globalThis.forwardTyped(
		iterable(values, log),
		[
			function map(value, index, missing = 4, ...rest) {
				check(
					this === context &&
						arguments.length === 2 &&
						missing === 4 &&
						rest.length === 0,
					"typed iterable arguments",
				);
				log.push("map" + index);
				if (index === 0) values[1] = 100;
				return {
					valueOf() {
						log.push("convert" + index);
						collectGarbage();
						return value + context.delta;
					},
				};
			},
		],
		false,
		context,
		Result,
	);
	check(result.join() === "2,4,255", "snapshot collection and clamped rounding");
	check(
		log.join() ===
			"iterator-get,iterator-call,next0,next1,next2,next3,construct3,map0,convert0,map1,convert1,map2,convert2",
		"typed iterable phase order",
	);
	const big = globalThis.forwardTyped(
		[1n, 4n],
		[
			function big(value, index) {
				return value + BigInt(index);
			},
		],
		false,
		undefined,
		BigInt64Array,
	);
	check(big[0] === 1n && big[1] === 5n, "BigInt mapper inputs");
	const closes = [];
	let calls = 0;
	let error;
	try {
		globalThis.forwardTyped(
			iterable([1, 2], closes, function close() {
				closes.push("close");
				return {};
			}),
			[
				function fail() {
					calls++;
					throw 17;
				},
			],
			false,
		);
	} catch (caught) {
		error = caught;
	}
	check(
		error === 17 && calls === 1 && !closes.includes("return-get"),
		"mapping starts after iterator exhausted",
	);
	console.log("typed-iter", log.join(), result.join(), String(big[1]), calls);
}
function runTypedLike() {
	const log = [];
	const source = {
		get [Symbol.iterator]() {
			log.push("iterator");
			return undefined;
		},
		get length() {
			log.push("length");
			return 3;
		},
		get 0() {
			log.push("get0");
			return 2;
		},
		get 1() {
			log.push("get1");
			return this.next;
		},
		2: 8,
		next: 3,
	};
	function Result(length) {
		log.push("construct" + length);
		return new Int16Array(length);
	}
	const result = globalThis.forwardTyped(
		source,
		[
			function map(value, index) {
				"use strict";
				check(this === undefined && arguments.length === 2, "typed strict default this");
				log.push("map" + index);
				return {
					valueOf() {
						log.push("convert" + index);
						source.next = 9;
						collectGarbage();
						return value + index;
					},
				};
			},
		],
		false,
		undefined,
		Result,
	);
	check(
		result.join() === "2,10,10" &&
			log.join() ===
				"iterator,length,construct3,get0,map0,convert0,get1,map1,convert1,map2,convert2",
		"typed array-like interleaved conversion and get",
	);
	let calls = 0;
	let error;
	try {
		globalThis.forwardTyped(
			{ 0: 1, 1: 2, length: 2 },
			[
				function invalid() {
					calls++;
					return Symbol("bad");
				},
			],
			false,
		);
	} catch (caught) {
		error = caught;
	}
	check(error instanceof TypeError && calls === 1, "typed conversion throws once");
	calls = 0;
	try {
		globalThis.forwardTyped(
			[1n],
			[
				function invalidBig(value) {
					calls++;
					return Number(value);
				},
			],
			false,
			undefined,
			BigInt64Array,
		);
	} catch (caught) {
		error = caught;
	}
	check(
		error instanceof TypeError && calls === 1,
		"BigInt result conversion remains generic",
	);
	let output;
	function Detached(length) {
		output = new Float64Array(length);
		return output;
	}
	const detached = globalThis.forwardTyped(
		{ 0: 1, 1: 2, length: 2 },
		[
			function detach(value, index) {
				if (index === 0) output.buffer.transfer();
				collectGarbage();
				return value;
			},
		],
		false,
		undefined,
		Detached,
	);
	check(detached.length === 0, "detachment during mapping");
	console.log("typed-like", log.join(), result.join(), calls, detached.length);
}
function runArity() {
	const nested = [];
	const shared = function shared(value, index, owner) {
		let number = index;
		for (let turn = 0; turn < 2; turn++) number += 1;
		if (owner !== undefined) {
			nested.push(globalThis.forwardArray(["a", "b"], [shared], false).join());
			nested.push(globalThis.forwardTyped([3, 4], [shared], false).join());
		} else {
			check(arguments.length === 2, "nested mapper arity");
		}
		return typeof value === "number" ? value + number : value + number;
	};
	[7, 8].forEach(shared);
	check(nested.join("|") === "a2,b3|5,7|a2,b3|5,7", "nested matching context");
	console.log("arity", nested.join("|"));
}
function runReentry() {
	const retained = [];
	let calls = 0;
	const callbacks = [
		function map(value, index) {
			calls++;
			if (index === 0) {
				retained.push(Function("return 17"));
				check(
					globalThis
						.forwardTyped(
							[2, 3],
							[
								function nested(value) {
									collectGarbage();
									return value * 2;
								},
							],
							false,
						)
						.join() === "4,6",
					"nested different mapper",
				);
			}
			collectGarbage();
			return value + index;
		},
	];
	const a = globalThis.forwardArray([1, 2, 3], callbacks, false);
	const b = globalThis.forwardTyped({ 0: 4, 1: 5, length: 2 }, callbacks, false);
	check(
		a.join() === "1,3,5" && b.join() === "4,6" && calls === 5 && retained[0]() === 17,
		"stable function index and captures",
	);
	console.log("reentry", a.join(), b.join(), calls, retained.length);
}
function runFallbacks() {
	let proxyCalls = 0;
	function add(value, index) {
		return value + index + this.delta;
	}
	const callbacks = [
		add.bind({ delta: 2 }),
		new Proxy(add, {
			apply(target, thisArg, args) {
				proxyCalls++;
				return Reflect.apply(target, { delta: 3 }, args);
			},
		}),
		Number,
		Function("value", "index", "return value + index + 4"),
	];
	const output = [];
	for (const callback of callbacks) {
		output.push(globalThis.forwardArray([1, 2], [callback], false).join());
		output.push(
			globalThis.forwardTyped({ 0: 1, 1: 2, length: 2 }, [callback], false).join(),
		);
	}
	check(
		proxyCalls === 4 && output.join("|") === "3,5|3,5|4,6|4,6|1,2|1,2|5,7|5,7",
		"unsupported mapper fallback",
	);
	let observed = 0;
	const source = {
		get [Symbol.iterator]() {
			observed++;
			return undefined;
		},
	};
	for (const callback of [3, {}, null]) {
		for (const method of [Array.from, Float64Array.from]) {
			let error;
			try {
				method.call(Float64Array, source, callback);
			} catch (caught) {
				error = caught;
			}
			check(error instanceof TypeError, "invalid mapper rejected");
		}
	}
	check(observed === 0, "mapper validation before source access");
	console.log("fallbacks", output.join("|"), proxyCalls);
}
if (mode === "all" || mode === "array-iter") runArrayIterable();
if (mode === "all" || mode === "array-like") runArrayLike();
if (mode === "all" || mode === "typed-iter") runTypedIterable();
if (mode === "all" || mode === "typed-like") runTypedLike();
if (mode === "all" || mode === "arity") runArity();
if (mode === "all" || mode === "reentry") runReentry();
if (mode === "all" || mode === "fallbacks") runFallbacks();
