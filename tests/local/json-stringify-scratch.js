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

const marker = new Error("marker");
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

console.log(failed ? "json-stringify-scratch FAIL" : "json-stringify-scratch PASS");
