const mode = process.env.GROUP_BY_KIND || "all";
const collectGarbage = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});
function check(value, message) {
	if (!value) throw new Error(message);
}
function forwardObject(source, callbacks, pick) {
	let callback = callbacks[0];
	if (pick) callback = callbacks[1];
	return Object.groupBy(source, callback);
}
function forwardMap(source, callbacks, pick) {
	let callback = callbacks[0];
	if (pick) callback = callbacks[1];
	return Map.groupBy(source, callback);
}
globalThis.forwardObject = forwardObject;
globalThis.forwardMap = forwardMap;
function makeIterable(values, log, close) {
	return {
		[Symbol.iterator]() {
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
		},
	};
}
function runObject() {
	const first = { id: 1 },
		second = { id: 2 },
		appended = { id: 3 };
	const symbol = Symbol("group");
	const source = [first, second, undefined, 1n, "last"];
	const log = [];
	let calls = 0;
	const result = globalThis.forwardObject(
		source,
		[
			function group(value, index, missing = 9, ...rest) {
				check(
					this === globalThis &&
						arguments.length === 2 &&
						missing === 9 &&
						rest.length === 0,
					"groupBy sloppy this and exact arguments",
				);
				check(source[index] === value, "original value identity");
				calls++;
				log.push("call" + index);
				collectGarbage();
				if (index === 0) source.push(appended);
				if (index === 1 || index === 5) return symbol;
				if (index === 3) return -0;
				if (index === 4)
					return {
						[Symbol.toPrimitive](hint) {
							check(hint === "string", "ToPropertyKey hint");
							log.push("key");
							collectGarbage();
							return "1";
						},
					};
				return "__proto__";
			},
		],
		false,
	);
	check(
		Object.getPrototypeOf(result) === null && calls === 6,
		"null prototype and live iterator length",
	);
	check(
		result.__proto__[0] === first && result.__proto__[1] === undefined,
		"prototype spelling is a data key",
	);
	check(
		result[symbol][0] === second &&
			result[symbol][1] === appended &&
			result[0][0] === 1n &&
			result[1][0] === "last",
		"symbol and integer property keys",
	);
	const keys = Reflect.ownKeys(result);
	check(
		keys[0] === "0" && keys[1] === "1" && keys[2] === "__proto__" && keys[3] === symbol,
		"own key order",
	);
	check(
		log.join() === "call0,call1,call2,call3,call4,key,call5",
		"key coercion before next callback",
	);
	const holes = globalThis.forwardObject(
		[, 2, ,],
		[
			function missing(value) {
				return value === undefined ? "missing" : "present";
			},
		],
		false,
	);
	check(holes.missing.length === 2 && holes.present[0] === 2, "holes become undefined");
	const unicode = globalThis.forwardObject(
		"😀a",
		[
			function unicode(value, index) {
				return index;
			},
		],
		false,
	);
	check(unicode[0][0] === "😀" && unicode[1][0] === "a", "string iterator values");
	function make(prefix) {
		return function captured(value) {
			return prefix + value;
		};
	}
	const closures = [make("a"), make("b")];
	check(
		globalThis.forwardObject([1, 2], closures, true).b2[0] === 2,
		"phi closure identity and environment",
	);
	console.log(
		"object",
		calls,
		log.join(),
		keys.length,
		holes.missing.length,
		unicode[0][0],
	);
}
function runMap() {
	const key = {
		toString() {
			throw new Error("Map key must not coerce");
		},
	};
	const symbol = Symbol("group");
	const source = [
		{ id: 0 },
		{ id: 1 },
		{ id: 2 },
		{ id: 3 },
		{ id: 4 },
		{ id: 5 },
		{ id: 6 },
		{ id: 7 },
	];
	const keys = [key, key, -0, 0, NaN, NaN, symbol, 1n];
	let calls = 0;
	const result = globalThis.forwardMap(
		source,
		[
			function group(value, index) {
				"use strict";
				check(
					this === undefined && arguments.length === 2 && value === source[index],
					"Map grouping arguments",
				);
				calls++;
				collectGarbage();
				return keys[index];
			},
		],
		false,
	);
	check(
		result.size === 5 &&
			result.get(key)[1] === source[1] &&
			result.get(0)[0] === source[2] &&
			result.get(NaN)[1] === source[5] &&
			result.get(symbol)[0] === source[6] &&
			result.get(1n)[0] === source[7],
		"Map key identity and SameValueZero",
	);
	const ordered = [...result.keys()];
	check(
		ordered[0] === key &&
			Object.is(ordered[1], 0) &&
			Number.isNaN(ordered[2]) &&
			ordered[3] === symbol &&
			ordered[4] === 1n,
		"Map insertion order and canonical zero",
	);
	const values = new Set([1, 2]);
	const live = globalThis.forwardMap(
		values,
		[
			function change(value, index) {
				if (index === 0) {
					values.delete(2);
					values.add(3);
				}
				return "all";
			},
		],
		false,
	);
	check(live.get("all").join() === "1,3", "live Set iterator mutation");
	const typed = globalThis.forwardMap(
		new BigInt64Array([1n, 2n, 3n]),
		[
			function parity(value) {
				return value & 1n;
			},
		],
		false,
	);
	check(typed.get(1n).join() === "1,3", "BigInt typed iterator inputs");
	console.log("map", calls, result.size, live.get("all").join(), typed.get(1n).join());
}
function runAbrupt() {
	const marker = { error: "mapper" };
	const output = [];
	for (const group of [globalThis.forwardObject, globalThis.forwardMap]) {
		const log = [];
		let calls = 0,
			caught;
		try {
			group(
				makeIterable([1, 2], log, function close() {
					log.push("close");
					throw new Error("closing");
				}),
				[
					function fail() {
						calls++;
						collectGarbage();
						throw marker;
					},
				],
				false,
			);
		} catch (error) {
			caught = error;
		}
		check(
			caught === marker && calls === 1 && log.join() === "next0,return-get,close",
			"callback abrupt completion wins close throw",
		);
		output.push(log.join());
		let closes = 0;
		try {
			group(
				{
					[Symbol.iterator]() {
						return {
							next() {
								throw marker;
							},
							return() {
								closes++;
								return {};
							},
						};
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
		check(
			caught === marker && closes === 0 && calls === 1,
			"next throw does not close or invoke mapper",
		);
	}
	const log = [];
	let keyCalls = 0,
		caught;
	try {
		globalThis.forwardObject(
			makeIterable([1, 2], log, function close() {
				log.push("close");
				return {};
			}),
			[
				function key() {
					return {
						[Symbol.toPrimitive]() {
							keyCalls++;
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
	check(
		caught === marker && keyCalls === 1 && log.join() === "next0,return-get,close",
		"key conversion closes iterator once",
	);
	check(
		globalThis
			.forwardMap(
				[4],
				[
					function recovered() {
						return "ok";
					},
				],
				false,
			)
			.get("ok")[0] === 4,
		"restored context after throw",
	);
	console.log("abrupt", output.join("|"), keyCalls);
}
function runReentry() {
	const log = [];
	let calls = 0;
	const callback = function outer(value, index) {
		calls++;
		if (index === 0) {
			const inner = globalThis.forwardMap(
				[4, 5],
				[
					function inner(value) {
						collectGarbage();
						return value & 1;
					},
				],
				false,
			);
			check(inner.get(0)[0] === 4 && inner.get(1)[0] === 5, "nested Map grouping");
		}
		return {
			[Symbol.toPrimitive]() {
				log.push("key" + index);
				const inner = globalThis.forwardObject(
					[7],
					[
						function nested() {
							collectGarbage();
							return "nested";
						},
					],
					false,
				);
				check(inner.nested[0] === 7, "key-coercion nested grouping");
				return "group";
			},
		};
	};
	const result = globalThis.forwardObject([2, 3], [callback], false);
	check(
		result.group.join() === "2,3" && calls === 2,
		"outer continuation after key reentry",
	);
	console.log("reentry", result.group.join(), log.join(), calls);
}
function runArity() {
	const output = [];
	const shared = function shared(value, index, owner) {
		let number = index;
		for (let turn = 0; turn < 2; turn++) number += 1;
		if (arguments.length === 3) {
			check(owner !== undefined, "outer callback receiver");
			const a = globalThis.forwardObject(["a", "b"], [shared], false);
			const b = globalThis.forwardMap([3n, 4n], [shared], false);
			output.push(a[2][0] + a[3][0] + ":" + b.get(2)[0] + b.get(3)[0]);
		} else
			check(
				arguments.length === 2 && owner === undefined,
				"nested groupBy two argument fallback",
			);
		collectGarbage();
		return number;
	};
	[5, 6].forEach(shared);
	check(output.join() === "ab:34,ab:34", "nested adapter continuation");
	console.log("arity", output.join());
}
function runFallbacks() {
	let proxyCalls = 0;
	function key(value) {
		return value & 1;
	}
	const callbacks = [
		key.bind(null),
		new Proxy(key, {
			apply(target, receiver, args) {
				proxyCalls++;
				return Reflect.apply(target, receiver, args);
			},
		}),
		String,
	];
	const output = [];
	for (const callback of callbacks) {
		const a = globalThis.forwardObject([1, 2], [callback], false);
		const b = globalThis.forwardMap([1, 2], [callback], false);
		output.push(Reflect.ownKeys(a).length + b.size);
	}
	check(proxyCalls === 4 && output.join() === "4,4,4", "bound proxy and native fallback");
	const revoked = Proxy.revocable(key, {});
	revoked.revoke();
	for (const callback of [revoked.proxy, class Invalid {}]) {
		for (const group of [globalThis.forwardObject, globalThis.forwardMap]) {
			let caught;
			try {
				group([1], [callback], false);
			} catch (error) {
				caught = error;
			}
			check(caught instanceof TypeError, "unsupported callable throws");
		}
	}
	console.log("fallbacks", output.join(), proxyCalls);
}
if (mode === "all" || mode === "object") runObject();
if (mode === "all" || mode === "map") runMap();
if (mode === "all" || mode === "abrupt") runAbrupt();
if (mode === "all" || mode === "reentry") runReentry();
if (mode === "all" || mode === "arity") runArity();
if (mode === "all" || mode === "fallbacks") runFallbacks();
