const mode = process.env.FROM_ENTRIES_KIND || "map";
const collectGarbage =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});
function check(ok, label) {
	if (!ok) throw new Error(label);
}
function ownMethod(object, key, value) {
	Object.defineProperty(object, key, { value, configurable: true });
}
if (mode === "map") {
	const symbol = Symbol("key");
	const payload = { marker: 7 };
	const map = new Map([
		["__proto__", payload],
		[symbol, 8],
		["last", 9],
	]);
	const result = Object.fromEntries(map);
	check(Object.getPrototypeOf(result) === Object.prototype, "result prototype");
	check(
		Object.hasOwn(result, "__proto__") && result.__proto__ === payload,
		"own proto data",
	);
	check(result[symbol] === 8 && result.last === 9, "symbol key");
	console.log("map", Object.keys(result).join(), result[symbol]);
} else if (mode === "set") {
	const first = {
		toString() {
			return "same";
		},
	};
	const second = {
		toString() {
			return "same";
		},
	};
	const symbol = Symbol("set");
	const result = Object.fromEntries(new Set([first, second, symbol]).entries());
	check(result.same === second && result[symbol] === symbol, "set duplicate values");
	console.log("set", Object.keys(result).join(), result[symbol] === symbol);
} else if (mode === "array") {
	const source = [0, 1, , 3];
	let reads = 0;
	const prototype = Object.create(Array.prototype);
	Object.defineProperty(prototype, "2", {
		get() {
			reads++;
			collectGarbage();
			return 22;
		},
	});
	Object.setPrototypeOf(source, prototype);
	Object.defineProperty(source, "0", {
		get() {
			reads++;
			source[1] = { marker: 11 };
			source.push(4);
			collectGarbage();
			return { marker: 10 };
		},
	});
	const result = Object.fromEntries(source.entries());
	check(
		reads === 2 && result[0].marker === 10 && result[1].marker === 11,
		"array live reads",
	);
	check(
		result[2] === 22 && result[3] === 3 && result[4] === 4,
		"array inherited and appended",
	);
	console.log("array", Object.keys(result).join(), reads);
} else if (mode === "mutation") {
	let iterator;
	let nextGets = 0;
	let map;
	const key = {
		[Symbol.toPrimitive](hint) {
			check(hint === "string", "property key hint");
			map.clear();
			map.set("appended", { marker: 9 });
			ownMethod(iterator, "next", () => {
				throw new Error("uncaptured next");
			});
			collectGarbage();
			return "first";
		},
	};
	map = new Map([
		[key, { marker: 7 }],
		["removed", 8],
	]);
	iterator = map.entries();
	const next = iterator.next;
	Object.defineProperty(iterator, "next", {
		configurable: true,
		get() {
			nextGets++;
			return next;
		},
	});
	const result = Object.fromEntries(iterator);
	check(
		nextGets === 1 && result.first.marker === 7 && result.appended.marker === 9,
		"captured pair and next",
	);
	check(!Object.hasOwn(result, "removed"), "clear live traversal");
	let consumed;
	const consumingKey = {
		toString() {
			const skipped = consumed.next();
			check(skipped.value[0] === "skipped", "reentrant consume");
			collectGarbage();
			return "kept";
		},
	};
	consumed = new Map([
		[consumingKey, 1],
		["skipped", 2],
		["tail", 3],
	]).entries();
	const consumedResult = Object.fromEntries(consumed);
	check(
		consumedResult.kept === 1 &&
			consumedResult.tail === 3 &&
			!Object.hasOwn(consumedResult, "skipped"),
		"consumed cursor",
	);
	let set;
	const setKey = {
		toString() {
			set.clear();
			set.add("later");
			collectGarbage();
			return "setFirst";
		},
	};
	set = new Set([setKey, "gone"]);
	const setResult = Object.fromEntries(set.entries());
	check(setResult.setFirst === setKey && setResult.later === "later", "set live capture");
	console.log("mutation", result.first.marker, consumedResult.tail, setResult.later);
} else if (mode === "abrupt") {
	const marker = { marker: "step" };
	let reads = 0;
	let closes = 0;
	const source = [0, 20];
	Object.defineProperty(source, "0", {
		get() {
			reads++;
			collectGarbage();
			throw marker;
		},
	});
	const iterator = source.entries();
	ownMethod(iterator, "return", () => {
		closes++;
		return {};
	});
	try {
		Object.fromEntries(iterator);
		throw new Error("missing step throw");
	} catch (error) {
		check(error === marker, "step error identity");
	}
	check(reads === 1 && closes === 0, "step never replayed or closed");
	check(iterator.next().value[1] === 20, "cursor advanced once");
	const conversionMarker = { marker: "key" };
	const throwingKey = {
		toString() {
			collectGarbage();
			throw conversionMarker;
		},
	};
	const mapIterator = new Map([[throwingKey, { marker: 8 }]]).entries();
	Object.defineProperty(mapIterator, "return", {
		get() {
			closes++;
			collectGarbage();
			throw new Error("secondary close");
		},
	});
	try {
		Object.fromEntries(mapIterator);
		throw new Error("missing key throw");
	} catch (error) {
		check(error === conversionMarker, "close throw precedence");
	}
	check(closes === 1, "conversion closes once");
	let wrongCloses = 0;
	const wrong = new Map([["wrong", 7]]).entries();
	ownMethod(wrong, "next", new Set().values().next);
	ownMethod(wrong, "return", () => {
		wrongCloses++;
		return {};
	});
	try {
		Object.fromEntries(wrong);
		throw new Error("missing brand error");
	} catch (error) {
		check(error instanceof TypeError, "wrong family brand error");
	}
	check(wrongCloses === 0, "wrong next abrupt never closes");
	console.log("abrupt", reads, closes);
} else if (mode === "fallbacks") {
	const log = [];
	const pair = {
		get 0() {
			log.push("key");
			return {
				toString() {
					log.push("coerce");
					collectGarbage();
					return "x";
				},
			};
		},
		get 1() {
			log.push("value");
			collectGarbage();
			return { marker: 31 };
		},
	};
	const iterator = new Map([["ignored", 0]]).entries();
	let calls = 0;
	ownMethod(iterator, "next", () =>
		++calls === 1 ? { value: pair, done: false } : { done: true },
	);
	const result = Object.fromEntries(iterator);
	check(
		result.x.marker === 31 && calls === 2 && log.join() === "key,value,coerce",
		"custom next and Gets",
	);
	const target = new Map([["proxy", 4]]).entries();
	const proxy = new Proxy(target, {
		get(object, property) {
			if (property === Symbol.iterator)
				return function () {
					return this;
				};
			if (property === "next") return object.next.bind(object);
			return Reflect.get(object, property);
		},
	});
	check(Object.fromEntries(proxy).proxy === 4, "proxy iterator");
	function* entries() {
		yield ["generated", 5];
	}
	check(Object.fromEntries(entries()).generated === 5, "generator");
	const borrowedPair = { 0: "values", 1: 6 };
	check(
		Object.fromEntries(new Set([borrowedPair]).values()).values === 6,
		"non-entry kind",
	);

	console.log("fallbacks", result.x.marker, calls, log.join());
} else throw new Error("unknown mode");
