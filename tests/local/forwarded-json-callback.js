const mode = process.env.JSON_CALLBACK_KIND || "all";
const collectGarbage = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});
function check(condition, message) {
	if (!condition) throw new Error(message);
}
function forwardParse(text, callbacks, pick) {
	let callback = callbacks[0];
	if (pick) callback = callbacks[1];
	return JSON.parse(text, callback);
}
function forwardStringify(value, callbacks, pick, space) {
	let callback = callbacks[0];
	if (pick) callback = callbacks[1];
	return JSON.stringify(value, callback, space);
}
globalThis.forwardParse = forwardParse;
globalThis.forwardStringify = forwardStringify;
function runParse() {
	const visits = [],
		contexts = [],
		holders = [];
	const source =
		'{"first":1,"same":2,"changed":3,"removed":4,"nested":{"x":1},"array":[1,2,3],"dupe":"old","dupe":"new","neg":-0,"text":"a\\nb"}';
	const callback = function reviver(key, value, context, missing = 7, ...rest) {
		check(
			arguments.length === 3 && missing === 7 && rest.length === 0,
			"reviver exact arguments",
		);
		check(
			Object.getPrototypeOf(context) === Object.prototype,
			"ordinary context prototype",
		);
		check(this[key] === value, "reviver holder identity");
		for (const prior of contexts) check(prior !== context, "fresh context per callback");
		contexts.push(context);
		holders.push(this);
		visits.push(key + ":" + String(context.source));
		if (Object.hasOwn(context, "source")) {
			const descriptor = Object.getOwnPropertyDescriptor(context, "source");
			check(
				descriptor.writable && descriptor.enumerable && descriptor.configurable,
				"source descriptor",
			);
		}
		collectGarbage();
		if (key === "first") {
			this.same = 2;
			this.changed = { fresh: 9 };
			delete this.removed;
		}
		if (key === "0" && Array.isArray(this)) this.push(4);
		if (key === "1" && Array.isArray(this)) return undefined;
		if (key === "x") return 12n;
		if (key === "") return { root: value };
		return value;
	};
	const result = globalThis.forwardParse(
		{
			toString() {
				return source;
			},
		},
		[callback],
		false,
	);
	check(
		result.root.nested.x === 12n &&
			result.root.changed.fresh === 9 &&
			!(1 in result.root.array) &&
			result.root.array.length === 4 &&
			result.root.array[3] === 4,
		"replacement, deletion and snapshotted array length",
	);
	check(
		Object.is(result.root.neg, -0) && result.root.text === "a\nb",
		"primitive values",
	);
	const order = visits.join("|");
	check(
		order ===
			'first:1|same:2|fresh:undefined|changed:undefined|removed:undefined|x:1|nested:undefined|0:1|1:2|2:3|array:undefined|dupe:"new"|neg:-0|text:"a\\nb"|:undefined',
		"postorder and source invalidation",
	);
	check(holders[holders.length - 1][""] === result.root, "synthetic root holder");
	let total = 0;
	function make(factor) {
		return function capture(key, value) {
			"use strict";
			check(typeof this === "object" && arguments.length === 3, "strict holder");
			if (typeof value === "number") total += value * factor;
			return value;
		};
	}
	globalThis.forwardParse("[2,3]", [make(2), make(3)], true);
	check(total === 15, "forwarded phi capture");
	console.log("parse", order, total, String(result.root.nested.x));
}
function runStringify() {
	const order = [];
	const child = {
		toJSON(key) {
			check(
				this === child && arguments.length === 1 && key === "b",
				"toJSON receiver and arity",
			);
			order.push("toJSON:b");
			collectGarbage();
			return { inner: 2 };
		},
	};
	const source = {};
	Object.defineProperty(source, "a", {
		enumerable: true,
		get() {
			order.push("get:a");
			return 1;
		},
	});
	source.b = child;
	source.omit = 3;
	source.tail = 4;
	source.arr = [undefined, 2, Symbol("missing")];
	source.big = 1n;
	const wrapped = new Number(3);
	Object.defineProperty(wrapped, "valueOf", {
		value() {
			order.push("unbox");
			collectGarbage();
			return 4;
		},
	});
	source.num = wrapped;
	const space = new Number(0);
	Object.defineProperty(space, "valueOf", {
		value() {
			order.push("space");
			return 0;
		},
	});
	const callback = function replacer(key, value, missing = 9, ...rest) {
		check(
			arguments.length === 2 &&
				missing === 9 &&
				rest.length === 0 &&
				typeof this === "object",
			"replacer arguments and holder",
		);
		if (key === "") check(this[""] === source, "root holder");
		order.push("replace:" + key);
		collectGarbage();
		if (key === "a") delete this.tail;
		if (key === "0" && Array.isArray(this)) {
			this.push(9);
			this[1] = 7;
		}
		if (key === "omit") return undefined;
		if (typeof value === "bigint") return String(value) + "n";
		return typeof value === "number" ? value * 2 : value;
	};
	const result = globalThis.forwardStringify(
		source,
		[
			function wrong() {
				throw new Error("wrong phi");
			},
			callback,
		],
		true,
		space,
	);
	check(
		result === '{"a":2,"b":{"inner":4},"arr":[null,14,null],"big":"1n","num":4}',
		"stringify transformed result and live elements within snapshotted length",
	);
	check(
		order.join() ===
			"space,replace:,get:a,replace:a,toJSON:b,replace:b,replace:inner,replace:omit,replace:tail,replace:arr,replace:0,replace:1,replace:2,replace:big,replace:num,unbox",
		"getter toJSON replacer and unbox order",
	);
	check(
		source.arr.length === 4,
		"replacer appended element remains outside serialization",
	);
	let toJSONCalls = 0,
		replacerCalls = 0;
	const both = function both(key, value) {
		collectGarbage();
		if (arguments.length === 1) {
			toJSONCalls++;
			return { inner: 2 };
		}
		check(arguments.length === 2, "same callback distinct roles");
		replacerCalls++;
		return value;
	};
	const same = globalThis.forwardStringify({ toJSON: both }, [both], false);
	check(
		same === '{"inner":2}' && toJSONCalls === 1 && replacerCalls === 2,
		"same toJSON and replacer function",
	);
	const list = JSON.stringify({ b: 2, a: 1 }, ["b", "a", "b"]);
	check(list === '{"b":2,"a":1}', "array replacer unaffected");
	console.log("stringify", result, order.join(), same, toJSONCalls, replacerCalls);
}
function runAbrupt() {
	const marker = { failure: true },
		output = [];
	let visits = 0,
		caught;
	try {
		globalThis.forwardParse(
			'{"a":1,"b":2,"c":3}',
			[
				function fail(key, value) {
					visits++;
					collectGarbage();
					if (key === "b") throw marker;
					return value;
				},
			],
			false,
		);
	} catch (error) {
		caught = error;
	}
	check(caught === marker && visits === 2, "reviver throw no replay");
	output.push(visits);
	const source = { a: 1, b: 2 };
	let gets = 0;
	Object.defineProperty(source, "c", {
		enumerable: true,
		get() {
			gets++;
			return 3;
		},
	});
	visits = 0;
	try {
		globalThis.forwardStringify(
			source,
			[
				function fail(key, value) {
					visits++;
					if (key === "b") throw marker;
					return value;
				},
			],
			false,
		);
	} catch (error) {
		caught = error;
	}
	check(
		caught === marker && visits === 3 && gets === 0,
		"replacer throw stops later getters",
	);
	output.push(visits);
	const wrapped = new Number(1);
	Object.defineProperty(wrapped, "valueOf", {
		value() {
			collectGarbage();
			throw marker;
		},
	});
	try {
		globalThis.forwardStringify(
			{ a: 1 },
			[
				function wrap(key, value) {
					return key === "a" ? wrapped : value;
				},
			],
			false,
		);
	} catch (error) {
		caught = error;
	}
	check(caught === marker, "rooted callback result coercion throw");
	const cyclic = {};
	cyclic.self = cyclic;
	for (const value of [cyclic, 1n]) {
		try {
			globalThis.forwardStringify(
				value,
				[
					function identity(key, value) {
						return value;
					},
				],
				false,
			);
		} catch (error) {
			caught = error;
		}
		check(caught instanceof TypeError, "ordinary serialization errors");
	}
	let replacerCalls = 0;
	try {
		globalThis.forwardStringify(
			{
				toJSON() {
					throw marker;
				},
			},
			[
				function unreachable() {
					replacerCalls++;
				},
			],
			false,
		);
	} catch (error) {
		caught = error;
	}
	check(caught === marker && replacerCalls === 0, "toJSON abrupt before replacer");
	const after = globalThis.forwardParse(
		"5",
		[
			function after(key, value) {
				return value + 1;
			},
		],
		false,
	);
	check(after === 6, "context restored after abrupt cleanup");
	console.log("abrupt", output.join(), gets, after);
}
function runInvalid() {
	let calls = 0,
		caught;
	const callback = function never(key, value) {
		calls++;
		return value;
	};
	for (const source of ['{"a":1', "1 2"]) {
		try {
			globalThis.forwardParse(source, [callback], false);
		} catch (error) {
			caught = error;
		}
		check(caught instanceof SyntaxError, "parse error before reviver nomination");
	}
	const marker = {};
	try {
		globalThis.forwardParse(
			{
				toString() {
					throw marker;
				},
			},
			[callback],
			false,
		);
	} catch (error) {
		caught = error;
	}
	check(caught === marker, "source coercion before callback");
	const space = new Number(2);
	Object.defineProperty(space, "valueOf", {
		value() {
			throw marker;
		},
	});
	try {
		globalThis.forwardStringify({ a: 1 }, [callback], false, space);
	} catch (error) {
		caught = error;
	}
	check(caught === marker && calls === 0, "space coercion before callback nomination");
	check(
		JSON.parse("2", {}) === 2 && JSON.stringify({ a: 1 }, null) === '{"a":1}',
		"noncallable callbacks ignored",
	);
	console.log("invalid", calls);
}
function runReentry() {
	let depth = 0;
	const log = [];
	const shared = function nested(key, value, context) {
		check(arguments.length === 2 || arguments.length === 3, "nested callback role");
		collectGarbage();
		if (key === "a" && depth === 0) {
			depth++;
			log.push(globalThis.forwardStringify({ z: 9 }, [shared], false));
			log.push(globalThis.forwardParse('{"x":4}', [shared], false).x);
			const marker = {};
			let caught;
			try {
				globalThis.forwardParse(
					"0",
					[
						function fail() {
							throw marker;
						},
					],
					false,
				);
			} catch (error) {
				caught = error;
			}
			check(caught === marker, "different nested callback throw restores context");
			depth--;
		}
		if (arguments.length === 3 && typeof value === "number")
			check(typeof context.source === "string", "nested parse context");
		return value;
	};
	const a = globalThis.forwardStringify({ a: 1, b: 2 }, [shared], false);
	const b = globalThis.forwardParse('{"a":3,"b":4}', [shared], false);
	check(
		a === '{"a":1,"b":2}' &&
			b.a === 3 &&
			b.b === 4 &&
			log.join() === '{"z":9},4,{"z":9},4',
		"cross-operation context restoration",
	);
	console.log("reentry", a, b.a, b.b, log.join());
}
function runArity() {
	const output = [];
	const shared = function shared(value, index, owner) {
		let number = index;
		for (let turn = 0; turn < 2; turn++) number += 1;
		if (arguments.length === 3 && Array.isArray(owner)) {
			const a = globalThis.forwardParse("3", [shared], false);
			const b = globalThis.forwardParse('"x"', [shared], false);
			const c = globalThis.forwardStringify(4, [shared], false);
			output.push(a + ":" + b + ":" + c);
		} else {
			check(typeof this === "object" && Object.hasOwn(this, ""), "typed fallback holder");
			check(
				arguments.length === 2 ? owner === undefined : typeof owner.source === "string",
				"typed fallback actual arguments",
			);
		}
		collectGarbage();
		return number;
	};
	[5, 6].forEach(shared);
	check(output.join() === "5:x11:6,5:x11:6", "same callback arity and number guards");
	console.log("arity", output.join());
}
function runFallbacks() {
	let proxyCalls = 0;
	function identity(key, value) {
		collectGarbage();
		return value;
	}
	const bound = identity.bind({ bound: true });
	const proxy = new Proxy(identity, {
		apply(fn, receiver, args) {
			proxyCalls++;
			return Reflect.apply(fn, receiver, args);
		},
	});
	const output = [];
	for (const callback of [bound, proxy]) {
		const parsed = globalThis.forwardParse('{"a":1}', [callback], false);
		const text = globalThis.forwardStringify(parsed, [callback], false);
		check(parsed.a === 1 && text === '{"a":1}', "bound and proxy callback fallback");
		output.push(text);
	}
	const numeric = globalThis.forwardParse("3", [Number], false);
	const text = globalThis.forwardStringify(3, [String], false);
	check(numeric === 0 && text === '""' && proxyCalls === 4, "native callback fallback");
	const revoked = Proxy.revocable(identity, {});
	revoked.revoke();
	for (const callback of [revoked.proxy, class Invalid {}]) {
		let caught;
		try {
			globalThis.forwardParse("0", [callback], false);
		} catch (error) {
			caught = error;
		}
		check(caught instanceof TypeError, "unsupported reviver throws");
		try {
			globalThis.forwardStringify(0, [callback], false);
		} catch (error) {
			caught = error;
		}
		check(caught instanceof TypeError, "unsupported replacer throws");
	}
	console.log("fallbacks", output.join(), numeric, text, proxyCalls);
}
if (mode === "all" || mode === "parse") runParse();
if (mode === "all" || mode === "stringify") runStringify();
if (mode === "all" || mode === "abrupt") runAbrupt();
if (mode === "all" || mode === "invalid") runInvalid();
if (mode === "all" || mode === "reentry") runReentry();
if (mode === "all" || mode === "arity") runArity();
if (mode === "all" || mode === "fallbacks") runFallbacks();
