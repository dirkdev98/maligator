let failed = false;
const gc = globalThis.__mal_collect_garbage;

function check(condition, message) {
	if (!condition) {
		failed = true;
		console.log("FAIL: " + message);
	}
}

function collect() {
	const garbage = [];
	for (let i = 0; i < 64; i++) garbage.push({ value: "garbage-" + i });
	if (typeof gc === "function") gc();
}

const wide = {};
const wideExpected = [];
for (let i = 0; i < 160; i++) {
	const value = "v".repeat((i % 23) + 1);
	wide["key" + i] = value;
	wideExpected.push('"key' + i + '":"' + value + '"');
}
check(
	JSON.stringify(wide) === "{" + wideExpected.join(",") + "}",
	"wide objects reuse member storage without retaining prior lengths",
);

const order = [];
const source = {};
Object.defineProperty(source, "first", {
	enumerable: true,
	get() {
		order.push("get:first");
		return {
			toJSON(key) {
				order.push("toJSON:" + key);
				collect();
				return { inner: 'line\n"\\', drop: undefined };
			},
		};
	},
});
Object.defineProperty(source, "omit", {
	enumerable: true,
	get() {
		order.push("get:omit");
		return 2;
	},
});
source.last = { leaf: 3 };

const pretty = JSON.stringify(
	source,
	function (key, value) {
		order.push("replace:" + key);
		return key === "omit" ? undefined : value;
	},
	2,
);
check(
	pretty ===
		[
			"{",
			'  "first": {',
			'    "inner": "line\\n\\"\\\\"',
			"  },",
			'  "last": {',
			'    "leaf": 3',
			"  }",
			"}",
		].join("\n"),
	"nested scratch output preserves indentation and escaping",
);
check(
	order.join(",") ===
		"replace:,get:first,toJSON:first,replace:first,replace:inner,replace:drop,get:omit,replace:omit,replace:last,replace:leaf",
	"getters, toJSON, and replacers retain their order",
);

check(
	JSON.stringify(
		{ a: { x: 1 }, b: undefined, c: 'quote"slash\\' },
		["c", "missing", "a", "c"],
		"\t",
	) === '{\n\t"c": "quote\\"slash\\\\",\n\t"a": {}\n}',
	"property-list omission and deduplication reset scratch members",
);

const proxyLog = [];
const proxyTarget = { a: 1, b: 2 };
const proxy = new Proxy(proxyTarget, {
	ownKeys(target) {
		proxyLog.push("ownKeys");
		return Reflect.ownKeys(target);
	},
	getOwnPropertyDescriptor(target, key) {
		proxyLog.push("desc:" + key);
		return Reflect.getOwnPropertyDescriptor(target, key);
	},
	get(target, key, receiver) {
		proxyLog.push("get:" + key);
		if (key === "a") delete target.b;
		return Reflect.get(target, key, receiver);
	},
});
check(
	JSON.stringify(proxy) === '{"a":1}' &&
		proxyLog.join(",") === "get:toJSON,ownKeys,desc:a,desc:b,get:a,get:b",
	"proxy descriptor and get mutation order remains stable",
);

const sameShapeMutation = { first: 1, later: 2 };
check(
	JSON.stringify(sameShapeMutation, function (key, value) {
		if (key === "first") this.later = 22;
		return value;
	}) === '{"first":1,"later":22}',
	"replacer reloads later values from the current slots",
);

const descriptorMutation = { first: 1, later: 2 };
check(
	JSON.stringify(descriptorMutation, function (key, value) {
		if (key === "first") {
			Object.defineProperty(this, "later", {
				enumerable: false,
				configurable: true,
				get() {
					collect();
					return 23;
				},
			});
		}
		return value;
	}) === '{"first":1,"later":23}',
	"replacer shape changes retain snapshotted keys and invoke getters",
);

let inheritedLaterGets = 0;
const mutationPrototype = {};
Object.defineProperty(mutationPrototype, "later", {
	get() {
		inheritedLaterGets++;
		return 41;
	},
});
const toJSONMutation = {
	first: {
		toJSON() {
			delete toJSONMutation.later;
			toJSONMutation.added = 43;
			collect();
			return 39;
		},
	},
	later: 4,
};
Object.setPrototypeOf(toJSONMutation, mutationPrototype);
check(
	JSON.stringify(toJSONMutation) === '{"first":39,"later":41}' &&
		inheritedLaterGets === 1,
	"toJSON shape changes fall back to inherited reads without adding keys",
);

const lateLog = [];
const lateSource = {
	prefix: "retained".repeat(256),
	nested: {
		before: 1,
		omitted: undefined,
		callback: {
			toJSON(key) {
				lateLog.push("toJSON:" + key);
				const nested = lateSource.nested;
				delete lateSource.nested;
				nested.before = 99;
				nested.omitted = 99;
				nested.added = 99;
				Object.defineProperty(nested, "later", {
					enumerable: false,
					get() {
						lateLog.push("get:nested-later");
						collect();
						return "\u0100";
					},
				});
				delete lateSource.after;
				Object.setPrototypeOf(lateSource, {
					get after() {
						lateLog.push("get:inherited-after");
						collect();
						return 3;
					},
				});
				lateSource.added = 99;
				collect();
				return undefined;
			},
		},
		later: 2,
	},
	after: 2,
};
check(
	JSON.stringify(lateSource) ===
		'{"prefix":"' +
		"retained".repeat(256) +
		'","nested":{"before":1,"later":"\u0100"},"after":3}' &&
		lateLog.join(",") ===
			"toJSON:callback,get:nested-later,get:inherited-after",
	"late fallback preserves prefix, omitted keys, detached holders, and ancestor key snapshots",
);

const lateArrayLog = [];
const lateArray = [
	"prefix",
	{
		toJSON(key) {
			lateArrayLog.push("toJSON:" + key);
			lateArray.length = 2;
			Object.setPrototypeOf(lateArray, {
				get 2() {
					lateArrayLog.push("get:2");
					collect();
					return undefined;
				},
			});
			lateArray[4] = 99;
			return undefined;
		},
	},
	2,
	3,
];
check(
	JSON.stringify(lateArray) === '["prefix",null,null,null]' &&
		lateArrayLog.join(",") === "toJSON:1,get:2",
	"late array fallback keeps the original length and performs inherited reads",
);

const lateProxyLog = [];
const lateProxyTarget = { first: 1, later: 2 };
const lateProxy = new Proxy(lateProxyTarget, {
	get(target, key, receiver) {
		lateProxyLog.push("get:" + key);
		if (key === "first") delete target.later;
		return Reflect.get(target, key, receiver);
	},
	ownKeys(target) {
		lateProxyLog.push("ownKeys");
		return Reflect.ownKeys(target);
	},
	getOwnPropertyDescriptor(target, key) {
		lateProxyLog.push("desc:" + key);
		return Reflect.getOwnPropertyDescriptor(target, key);
	},
});
check(
	JSON.stringify({ prefix: [1, 2, 3], proxy: lateProxy, last: 4 }) ===
		'{"prefix":[1,2,3],"proxy":{"first":1},"last":4}' &&
		lateProxyLog.join(",") ===
			"get:toJSON,ownKeys,desc:first,desc:later,get:first,get:later",
	"late proxy fallback performs each trap once in descriptor-before-get order",
);

const lateCycle = {
	prefix: [1, 2, 3],
	callback: {
		toJSON() {
			return lateCycle;
		},
	},
};
let lateCycleError = false;
try {
	JSON.stringify(lateCycle);
} catch (error) {
	lateCycleError = error instanceof TypeError;
}
check(lateCycleError, "late toJSON retains ancestor cycle membership");

const bigintLog = [];
const bigintSource = { prefix: [1, 2], bigint: 2n, later: 3 };
BigInt.prototype.toJSON = function (key) {
	bigintLog.push(key);
	bigintSource.later = 4;
	collect();
	return String(this);
};
check(
	JSON.stringify(bigintSource) ===
		'{"prefix":[1,2],"bigint":"2","later":4}' &&
		bigintLog.join(",") === "bigint",
	"late BigInt fallback invokes inherited toJSON with the original key",
);
delete BigInt.prototype.toJSON;

const uncachedRows = [];
for (let i = 0; i < 300; i++) uncachedRows.push({ ["unique" + i]: i });
uncachedRows.push({
	uncachedBefore: 1,
	uncachedCallback: {
		toJSON() {
			Object.defineProperty(uncachedRows[300], "uncachedLater", {
				enumerable: false,
				get() {
					collect();
					return 4;
				},
			});
			return undefined;
		},
	},
	uncachedLater: 2,
});
check(
	JSON.stringify(uncachedRows).endsWith(
		',{"uncachedBefore":1,"uncachedLater":4}]',
	),
	"late fallback retains uncached shape key snapshots after many unique shapes",
);

const marker = new Error("marker");
const lateThrowLog = [];
const lateThrowing = {
	prefix: "retained".repeat(256),
	callback: {
		get toJSON() {
			lateThrowLog.push("get:toJSON");
			return function (key) {
				lateThrowLog.push("call:" + key);
				collect();
				throw marker;
			};
		},
	},
	later: {
		toJSON() {
			lateThrowLog.push("later");
		},
	},
};
let lateCaught;
try {
	JSON.stringify(lateThrowing);
} catch (error) {
	lateCaught = error;
}
check(
	lateCaught === marker &&
		lateThrowLog.join(",") === "get:toJSON,call:callback" &&
		JSON.stringify({ after: "late throw" }) === '{"after":"late throw"}',
	"late throwing toJSON reads and calls once, stops later work, and releases traversal state",
);

const throwLog = [];
const throwing = {};
Object.defineProperty(throwing, "first", {
	enumerable: true,
	get() {
		throwLog.push("first");
		return "x".repeat(128);
	},
});
Object.defineProperty(throwing, "second", {
	enumerable: true,
	get() {
		throwLog.push("second");
		throw marker;
	},
});
Object.defineProperty(throwing, "third", {
	enumerable: true,
	get() {
		throwLog.push("third");
		return 3;
	},
});
let caught;
try {
	JSON.stringify(throwing);
} catch (error) {
	caught = error;
}
check(
	caught === marker && throwLog.join(",") === "first,second",
	"throws stop later getters",
);
check(
	JSON.stringify({ after: "throw" }) === '{"after":"throw"}',
	"throw cleanup is traversal-local",
);

const toJSONLog = [];
const toJSONThrowing = {
	first: {
		toJSON() {
			toJSONLog.push("toJSON");
			throw marker;
		},
	},
};
Object.defineProperty(toJSONThrowing, "later", {
	enumerable: true,
	get() {
		toJSONLog.push("later");
		return 2;
	},
});
try {
	JSON.stringify(toJSONThrowing);
} catch (error) {
	check(error === marker, "toJSON preserves the thrown value");
}
check(toJSONLog.join(",") === "toJSON", "toJSON throws stop later getters");

const replacerLog = [];
const replacerThrowing = { first: "x".repeat(128), second: 2 };
Object.defineProperty(replacerThrowing, "later", {
	enumerable: true,
	get() {
		replacerLog.push("get:later");
		return 3;
	},
});
try {
	JSON.stringify(replacerThrowing, function (key, value) {
		if (key !== "") replacerLog.push("replace:" + key);
		if (key === "second") throw marker;
		return value;
	});
} catch (error) {
	check(error === marker, "replacer preserves the thrown value");
}
check(
	replacerLog.join(",") === "replace:first,replace:second",
	"replacer throws after scratch reuse and stops later getters",
);

const cycle = {};
cycle.self = cycle;
let cycleError = false;
let bigintError = false;
try {
	JSON.stringify(cycle);
} catch (error) {
	cycleError = error instanceof TypeError;
}
try {
	JSON.stringify({ before: 1, value: 2n, after: 3 });
} catch (error) {
	bigintError = error instanceof TypeError;
}
check(cycleError && bigintError, "cycles and BigInts still throw TypeError");
check(
	JSON.stringify("\ud800A\udc00") === '"\\ud800A\\udc00"',
	"lone surrogates remain escaped",
);
check(
	JSON.stringify([
		{
			toJSON(key) {
				return key;
			},
		},
		2,
	]) === '["0",2]',
	"array toJSON receives its materialized index key",
);
check(
	JSON.stringify({
		toJSON(key) {
			return key === "" ? "root" : "bad";
		},
	}) === '"root"',
	"direct root serialization preserves the empty toJSON key",
);

console.log(failed ? "json-stringify-scratch FAIL" : "json-stringify-scratch PASS");
