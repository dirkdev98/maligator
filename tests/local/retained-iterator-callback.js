const mode = process.env.ITERATOR_LAZY_KIND || "all";
const collectGarbage = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});
function check(ok, message) {
	if (!ok) throw new Error(message);
}
function forwardLazy(iterator, method, callbacks, pick) {
	let callback = callbacks[0];
	if (pick) callback = callbacks[1];
	return Iterator.prototype[method].call(iterator, callback);
}
globalThis.forwardLazy = forwardLazy;
function retained(method) {
	let factor = 2;
	const seen = [];
	const values = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
	function callback(value, index, missing = 9, ...rest) {
		check(
			this === globalThis && arguments.length === 2 && missing === 9 && rest.length === 0,
			"callback arguments",
		);
		collectGarbage();
		check(value === values[index], "retained element");
		seen.push(index);
		if (method === "map") return value.id * factor;
		if (method === "filter") return value.id % 2 === 0;
		return [value.id * factor];
	}
	const helper = globalThis.forwardLazy(values.values(), method, [null, callback], true);
	const first = helper.next().value;
	factor = 3;
	collectGarbage();
	const rest = helper.toArray();
	const out = [first, ...rest].map((value) =>
		typeof value === "object" ? value.id : value,
	);
	check(
		out.join() === (method === "filter" ? "2,4" : "2,6,9,12"),
		"live capture across resumes",
	);
	check(seen.join() === "0,1,2,3" && helper.next().done, "indices and completion");
	console.log(method, out.join(), seen.join());
}
function abrupt() {
	const marker = {},
		closeMarker = {};
	for (const method of ["map", "filter", "flatMap"]) {
		let calls = 0,
			closes = 0,
			callbackCalls = 0;
		const source = {
			next() {
				calls++;
				throw marker;
			},
			return() {
				closes++;
				return {};
			},
		};
		const helper = globalThis.forwardLazy(
			source,
			method,
			[
				function callback() {
					callbackCalls++;
					return [];
				},
			],
			false,
		);
		let caught;
		try {
			helper.next();
		} catch (error) {
			caught = error;
		}
		check(
			caught === marker &&
				helper.next().done &&
				calls === 1 &&
				closes === 0 &&
				callbackCalls === 0,
			"next abrupt completes helper",
		);
		const other = globalThis.forwardLazy(
			{
				next() {
					return { value: 1, done: false };
				},
				return() {
					closes++;
					throw closeMarker;
				},
			},
			method,
			[
				function fail() {
					collectGarbage();
					throw marker;
				},
			],
			false,
		);
		try {
			other.next();
		} catch (error) {
			caught = error;
		}
		check(
			caught === marker && other.next().done && closes === 1,
			"callback abrupt precedence",
		);
	}
	const log = [];
	const outer = {
		next() {
			return { value: 1, done: false };
		},
		return() {
			log.push("outer");
			return {};
		},
	};
	const helper = globalThis.forwardLazy(
		outer,
		"flatMap",
		[
			function mapper() {
				return {
					next() {
						throw marker;
					},
					return() {
						log.push("inner");
						return {};
					},
				};
			},
		],
		false,
	);
	let caught;
	try {
		helper.next();
	} catch (error) {
		caught = error;
	}
	check(
		caught === marker && helper.next().done && log.join() === "outer",
		"inner abrupt closes outer",
	);
	console.log("abrupt", "completed", log.join());
}
function reentry() {
	let helper,
		calls = 0,
		guards = 0;
	function callback(value, index) {
		calls++;
		try {
			helper.next();
		} catch (error) {
			check(error instanceof TypeError, "next guard");
			guards++;
		}
		try {
			helper.return();
		} catch (error) {
			check(error instanceof TypeError, "return guard");
			guards++;
		}
		const nested = globalThis.forwardLazy(
			[10].values(),
			"map",
			[
				function inner(v) {
					collectGarbage();
					return v + 1;
				},
			],
			false,
		);
		check(nested.next().value === 11, "nested context");
		return value + index;
	}
	helper = globalThis.forwardLazy([2, 3].values(), "map", [callback], false);
	check(
		helper.next().value === 2 &&
			helper.next().value === 4 &&
			helper.next().done &&
			calls === 2 &&
			guards === 4,
		"caught reentry does not finish outer",
	);
	const log = [];
	const outer = {
		next() {
			return { value: 1, done: false };
		},
		return() {
			log.push("outer");
			return {};
		},
	};
	const flat = globalThis.forwardLazy(
		outer,
		"flatMap",
		[
			function mapper() {
				return {
					next() {
						return { value: 4, done: false };
					},
					return() {
						log.push("inner");
						return {};
					},
				};
			},
		],
		false,
	);
	check(flat.next().value === 4, "flat first");
	flat.return();
	flat.return();
	check(log.join() === "inner,outer", "close ordering once");
	console.log("reentry", calls, guards, log.join());
}
function roots() {
	let index = 0;
	const filtered = globalThis.forwardLazy(
		{
			next() {
				return index++ < 2 ? { value: { id: index }, done: false } : { done: true };
			},
		},
		"filter",
		[
			function keep() {
				collectGarbage();
				return true;
			},
		],
		false,
	);
	check(
		filtered.next().value.id === 1 && filtered.toArray()[0].id === 2,
		"filter retained value",
	);
	const flattened = globalThis.forwardLazy(
		[1, 2].values(),
		"flatMap",
		[
			function mapper(value) {
				return {
					get [Symbol.iterator]() {
						collectGarbage();
						return function () {
							return {
								payload: { id: value },
								get next() {
									collectGarbage();
									return function () {
										const payload = this.payload;
										this.payload = null;
										return payload ? { value: payload, done: false } : { done: true };
									};
								},
							};
						};
					},
				};
			},
		],
		false,
	);
	check(
		flattened.next().value.id === 1 && flattened.toArray()[0].id === 2,
		"fresh flattenable iterator root",
	);
	console.log("roots", "retained");
}
function fallbacks() {
	function mapper(value, index) {
		return value + index;
	}
	const bound = mapper.bind(null);
	const proxy = new Proxy(mapper, {
		apply(target, thisArg, args) {
			collectGarbage();
			return Reflect.apply(target, thisArg, args);
		},
	});
	for (const callback of [bound, proxy, Boolean]) {
		const helper = globalThis.forwardLazy([2, 3].values(), "map", [callback], false);
		check(
			helper.toArray().join() === (callback === Boolean ? "true,true" : "2,4"),
			"unsupported fallback",
		);
	}
	const generated = globalThis.forwardLazy(
		[3].values(),
		"map",
		[
			function* generator(value) {
				yield value;
			},
		],
		false,
	);
	check(generated.next().value.next().value === 3, "generator callback fallback");
	const asynchronous = globalThis.forwardLazy(
		[3].values(),
		"map",
		[
			async function callback(value) {
				return value;
			},
		],
		false,
	);
	check(asynchronous.next().value instanceof Promise, "async callback fallback");
	let calls = 0;
	const helper = globalThis.forwardLazy([1].values(), "map", [bound], false);
	Object.defineProperty(helper, "next", {
		value() {
			calls++;
			return { value: 8, done: calls > 1 };
		},
	});
	check(helper.toArray().join() === "8" && calls === 2, "own next override");
	const classHelper = globalThis.forwardLazy(
		[1].values(),
		"map",
		[class Callback {}],
		false,
	);
	let caught;
	try {
		classHelper.next();
	} catch (error) {
		caught = error;
	}
	check(caught instanceof TypeError && classHelper.next().done, "class fails lazily");
	console.log("fallbacks", calls);
}
function arity() {
	let depth = 0,
		retained;
	const shared = function shared(value, index, collection) {
		let number = index;
		for (let turn = 0; turn < 2; turn++) number += 1;
		if (depth === 0) {
			depth = 1;
			const helper = globalThis.forwardLazy([5, 6].values(), "map", [shared], false);
			check(helper.next().value === 5, "matching typed context fallback");
			retained = helper;
			depth = 0;
			return value + number + collection.length - 2;
		}
		check(arguments.length === 2 && collection === undefined, "lazy two arguments");
		collectGarbage();
		return value + number - 2;
	};
	const output = [1, 2].map(shared);
	depth = 1;
	check(
		retained.next().value === 7 && retained.next().done,
		"canonical resume after typed context expired",
	);
	console.log("arity", output.join());
}
for (const method of ["map", "filter", "flatMap"])
	if (mode === "all" || mode === method) retained(method);
if (mode === "all" || mode === "abrupt") abrupt();
if (mode === "all" || mode === "reentry") reentry();
if (mode === "all" || mode === "roots") roots();
if (mode === "all" || mode === "fallbacks") fallbacks();
if (mode === "arity") arity();
