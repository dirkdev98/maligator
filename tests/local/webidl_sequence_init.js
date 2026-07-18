const results = [];
const forceGc = globalThis.__mal_collect_garbage;

function check(name, condition) {
	results.push([name, !!condition]);
}

function throwsTypeError(fn) {
	try {
		fn();
		return false;
	} catch (error) {
		return error instanceof TypeError;
	}
}

function getterIterable(pairs, state) {
	const init = {};
	Object.defineProperty(init, Symbol.iterator, {
		get() {
			state.gets++;
			return function () {
				return pairs[Symbol.iterator]();
			};
		},
	});
	return init;
}

const headersState = { gets: 0 };
const headersFromSequence = new Headers(
	getterIterable([["X-Sequence", " value "]], headersState),
);
check(
	"Headers gets the union iterator once",
	headersState.gets === 1 && headersFromSequence.get("x-sequence") === "value",
);

const paramsState = { gets: 0 };
const paramsFromSequence = new URLSearchParams(
	getterIterable([["sequence", "yes"]], paramsState),
);
check(
	"URLSearchParams gets the union iterator once",
	paramsState.gets === 1 && paramsFromSequence.toString() === "sequence=yes",
);

const brandedHeaders = new Headers({ ignored: "record" });
brandedHeaders[Symbol.iterator] = function () {
	return [["X-Custom", "headers"]][Symbol.iterator]();
};
const customHeaders = new Headers(brandedHeaders);
check(
	"Headers honors a branded custom iterator",
	customHeaders.get("x-custom") === "headers" && !customHeaders.has("ignored"),
);

const brandedParams = new URLSearchParams("ignored=record");
brandedParams[Symbol.iterator] = function () {
	return [["custom", "params"]][Symbol.iterator]();
};
check(
	"URLSearchParams honors a branded custom iterator",
	new URLSearchParams(brandedParams).toString() === "custom=params",
);

let conversionOrder = "";
const stagedHeaders = [
	[
		{
			toString() {
				conversionOrder += "a";
				return "bad name";
			},
		},
		{
			toString() {
				conversionOrder += "b";
				return "value";
			},
		},
	],
	[
		{
			toString() {
				conversionOrder += "c";
				return "later";
			},
		},
		{
			toString() {
				conversionOrder += "d";
				return "value";
			},
		},
	],
];
check(
	"Headers stages the complete sequence before validation",
	throwsTypeError(() => new Headers(stagedHeaders)) && conversionOrder === "abcd",
);

let thirdConverted = 0;
const threeItemPair = [
	"name",
	"value",
	{
		toString() {
			thirdConverted++;
			return "extra";
		},
	},
];
check(
	"Headers converts all pair items before exact arity",
	throwsTypeError(() => new Headers([threeItemPair])) && thirdConverted === 1,
);

function stagesOuterBeforeArity(Constructor) {
	let order = "";
	const init = [
		[
			{
				toString() {
					order += "a";
					return "one";
				},
			},
		],
		[
			{
				toString() {
					order += "b";
					return "two";
				},
			},
			{
				toString() {
					order += "c";
					return "three";
				},
			},
		],
	];
	return throwsTypeError(() => new Constructor(init)) && order === "abc";
}

check(
	"both constructors stage the outer sequence before pair arity",
	stagesOuterBeforeArity(Headers) && stagesOuterBeforeArity(URLSearchParams),
);
check(
	"both constructors require exactly two pair items",
	throwsTypeError(() => new Headers([["one"]])) &&
		throwsTypeError(() => new URLSearchParams([["one"]])) &&
		throwsTypeError(() => new URLSearchParams([["one", "two", "three"]])),
);
check(
	"Headers sequence elements use ByteString",
	throwsTypeError(() => new Headers([["x", "wide-\u0100"]])),
);

check(
	"URLSearchParams sequence elements use USVString",
	new URLSearchParams([["\ud800", "\udc00"]]).toString() === "%EF%BF%BD=%EF%BF%BD",
);
check(
	"URLSearchParams scalar primitives use USVString",
	new URLSearchParams(42).toString() === "42=" &&
		new URLSearchParams(true).toString() === "true=" &&
		new URLSearchParams("x=\ud800").toString() === "x=%EF%BF%BD",
);
check(
	"URLSearchParams record arm remains available",
	new URLSearchParams({ record: 7 }).toString() === "record=7",
);

let headerAccessorCalls = 0;
const headerAccessorRecord = {};
Object.defineProperty(headerAccessorRecord, "X-Accessor", {
	enumerable: true,
	get() {
		headerAccessorCalls++;
		return " value ";
	},
});
const accessorHeaders = new Headers(headerAccessorRecord);
let paramsAccessorCalls = 0;
const paramsAccessorRecord = {};
Object.defineProperty(paramsAccessorRecord, "accessor", {
	enumerable: true,
	get() {
		paramsAccessorCalls++;
		return 42;
	},
});
check(
	"record conversion uses Get and invokes accessors once",
	headerAccessorCalls === 1 &&
		accessorHeaders.get("x-accessor") === "value" &&
		new URLSearchParams(paramsAccessorRecord).toString() === "accessor=42" &&
		paramsAccessorCalls === 1,
);

function abruptRecord(Constructor) {
	const marker = {};
	let laterGets = 0;
	const record = {};
	Object.defineProperty(record, "first", {
		enumerable: true,
		get() {
			throw marker;
		},
	});
	Object.defineProperty(record, "later", {
		enumerable: true,
		get() {
			laterGets++;
			return "later";
		},
	});
	try {
		new Constructor(record);
	} catch (error) {
		return error === marker && laterGets === 0;
	}
	return false;
}

check(
	"record Get abrupt completions are preserved",
	abruptRecord(Headers) && abruptRecord(URLSearchParams),
);

let recordValidationOrder = "";
const stagedHeaderRecord = {};
Object.defineProperty(stagedHeaderRecord, "bad name", {
	enumerable: true,
	get() {
		recordValidationOrder += "a";
		return "first";
	},
});
Object.defineProperty(stagedHeaderRecord, "later", {
	enumerable: true,
	get() {
		recordValidationOrder += "b";
		return "second";
	},
});
check(
	"Headers stages the complete record before validation",
	throwsTypeError(() => new Headers(stagedHeaderRecord)) &&
		recordValidationOrder === "ab",
);

function mutationRecord() {
	const record = {};
	Object.defineProperty(record, "first", {
		enumerable: true,
		get() {
			delete record.second;
			Object.defineProperty(record, "third", {
				value: "hidden",
				enumerable: false,
				configurable: true,
			});
			record.added = "not snapshotted";
			return "one";
		},
	});
	Object.defineProperty(record, "second", {
		value: "deleted",
		enumerable: true,
		configurable: true,
	});
	Object.defineProperty(record, "third", {
		value: "visible",
		enumerable: true,
		configurable: true,
	});
	return record;
}

const mutationHeaders = new Headers(mutationRecord());
check(
	"record keys are snapshotted and descriptors are read live",
	new URLSearchParams(mutationRecord()).toString() === "first=one" &&
		mutationHeaders.get("first") === "one" &&
		!mutationHeaders.has("second") &&
		!mutationHeaders.has("third") &&
		!mutationHeaders.has("added"),
);

let wideKeyGetterCalls = 0;
const wideHeaderRecord = {};
Object.defineProperty(wideHeaderRecord, "\u0100", {
	enumerable: true,
	get() {
		wideKeyGetterCalls++;
		return "not reached";
	},
});
let symbolGetterCalls = 0;
const symbolRecord = {};
Object.defineProperty(symbolRecord, Symbol("record"), {
	enumerable: true,
	get() {
		symbolGetterCalls++;
		return "not reached";
	},
});
check(
	"record keys convert before Get",
	throwsTypeError(() => new Headers(wideHeaderRecord)) &&
		wideKeyGetterCalls === 0 &&
		throwsTypeError(() => new URLSearchParams(symbolRecord)) &&
		symbolGetterCalls === 0,
);

check(
	"record conversion includes numeric own keys",
	new Headers({ 0: "zero" }).get("0") === "zero" &&
		new URLSearchParams({ 0: "zero" }).toString() === "0=zero",
);

const collisionRecord = {};
collisionRecord["\ud800"] = "first";
collisionRecord["\ufffd"] = "second";
collisionRecord.after = "third";
const collided = new URLSearchParams(collisionRecord);
check(
	"USVString record-key collisions replace in map order",
	collided.toString() === "%EF%BF%BD=second&after=third" && collided.size === 2,
);

function proxyRecord(Constructor) {
	const order = [];
	const proxy = new Proxy(
		{},
		{
			get(target, key) {
				if (key === Symbol.iterator) {
					order.push("iterator");
					return undefined;
				}
				order.push("get:" + key);
				return key === "a" ? "1" : "2";
			},
			ownKeys() {
				order.push("ownKeys");
				return ["a", "b"];
			},
			getOwnPropertyDescriptor(target, key) {
				order.push("desc:" + key);
				return { enumerable: true, configurable: true };
			},
		},
	);
	const value = new Constructor(proxy);
	const converted =
		Constructor === Headers
			? value.get("a") === "1" && value.get("b") === "2"
			: value.toString() === "a=1&b=2";
	return converted && order.join("|") === "iterator|ownKeys|desc:a|get:a|desc:b|get:b";
}

check(
	"record conversion uses proxy internal methods in order",
	proxyRecord(Headers) && proxyRecord(URLSearchParams),
);

check(
	"living Web IDL null union behavior",
	throwsTypeError(() => new Headers(null)) &&
		new URLSearchParams(null).toString() === "null=" &&
		new URLSearchParams(undefined).toString() === "",
);

function innerProtocol(Constructor) {
	const counters = {
		methodGets: 0,
		nextGets: 0,
		nextCalls: 0,
		doneGets: 0,
		valueGets: 0,
	};
	const pair = {};
	Object.defineProperty(pair, Symbol.iterator, {
		get() {
			counters.methodGets++;
			return function () {
				let index = 0;
				const iterator = {};
				Object.defineProperty(iterator, "next", {
					get() {
						counters.nextGets++;
						return function () {
							counters.nextCalls++;
							const current = index++;
							const result = {};
							Object.defineProperty(result, "done", {
								get() {
									counters.doneGets++;
									return current === 2;
								},
							});
							Object.defineProperty(result, "value", {
								get() {
									counters.valueGets++;
									return current === 0 ? "name" : "value";
								},
							});
							return result;
						};
					},
				});
				return iterator;
			};
		},
	});
	new Constructor([pair]);
	return (
		counters.methodGets === 1 &&
		counters.nextGets === 1 &&
		counters.nextCalls === 3 &&
		counters.doneGets === 3 &&
		counters.valueGets === 2
	);
}

check(
	"inner sequence iterator protocol is observed exactly",
	innerProtocol(Headers) && innerProtocol(URLSearchParams),
);

function abruptSequence(Constructor) {
	const marker = {};
	let outerClosed = 0;
	let innerClosed = 0;
	const pair = {
		[Symbol.iterator]() {
			let done = false;
			return {
				next() {
					if (done) return { done: true };
					done = true;
					return {
						done: false,
						value: {
							toString() {
								throw marker;
							},
						},
					};
				},
				return() {
					innerClosed++;
					return { done: true };
				},
			};
		},
	};
	const init = {
		[Symbol.iterator]() {
			let done = false;
			return {
				next() {
					if (done) return { done: true };
					done = true;
					return { done: false, value: pair };
				},
				return() {
					outerClosed++;
					return { done: true };
				},
			};
		},
	};
	let preserved = false;
	try {
		new Constructor(init);
	} catch (error) {
		preserved = error === marker;
	}
	return preserved && outerClosed === 0 && innerClosed === 0;
}

function abruptInnerNextGetter(Constructor) {
	const marker = {};
	let methodGets = 0;
	let nextGets = 0;
	let outerClosed = 0;
	const pair = {};
	Object.defineProperty(pair, Symbol.iterator, {
		get() {
			methodGets++;
			return function () {
				const iterator = {};
				Object.defineProperty(iterator, "next", {
					get() {
						nextGets++;
						throw marker;
					},
				});
				return iterator;
			};
		},
	});
	const init = {
		[Symbol.iterator]() {
			let done = false;
			return {
				next() {
					if (done) return { done: true };
					done = true;
					return { done: false, value: pair };
				},
				return() {
					outerClosed++;
					return { done: true };
				},
			};
		},
	};
	let preserved = false;
	try {
		new Constructor(init);
	} catch (error) {
		preserved = error === marker;
	}
	return preserved && methodGets === 1 && nextGets === 1 && outerClosed === 0;
}

check(
	"current Web IDL abrupt iteration behavior is preserved",
	abruptSequence(Headers) &&
		abruptSequence(URLSearchParams) &&
		abruptInnerNextGetter(Headers) &&
		abruptInnerNextGetter(URLSearchParams),
);

const carded = new URLSearchParams();
forceGc();
for (let i = 0; i < 24; i++) {
	carded.append(
		{
			toString() {
				return "name" + i;
			},
		},
		{
			toString() {
				return "value" + i;
			},
		},
	);
}
check(
	"URLSearchParams append cards retain young strings",
	carded.get("name0") === "value0" && carded.get("name23") === "value23",
);

const mutated = new URLSearchParams([
	["replace", "old"],
	["delete", "gone"],
]);
forceGc();
mutated.set(
	{
		toString() {
			return "replace";
		},
	},
	{
		toString() {
			return "young-" + 1;
		},
	},
);
mutated.append("tail", {
	toString() {
		return "young-" + 2;
	},
});
mutated.delete("delete");
check(
	"URLSearchParams set/delete barriers retain compacted young strings",
	mutated.toString() === "replace=young-1&tail=young-2",
);

let passed = 0;
for (const [name, ok] of results) {
	if (ok) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
