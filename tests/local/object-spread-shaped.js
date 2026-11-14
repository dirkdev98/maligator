"use strict";

const gc = globalThis.__mal_collect_garbage;
if (typeof gc !== "function") {
	throw new Error("object-spread-shaped requires MAL_HOST_GC=1");
}

let passed = 0;
function check(name, condition) {
	if (!condition) throw new Error("FAIL " + name);
	passed++;
}

const shared = { marker: 17 };
const shapedSource = {
	kind: 7,
	flags: 3,
	generation: 11,
	block: 13,
	value: shared,
};
for (let index = 0; index < 32; index++) {
	const copy = { ...shapedSource };
	check(
		"shaped shallow copy " + index,
		Object.keys(copy).join(",") === "kind,flags,generation,block,value" &&
			copy.value === shared &&
			copy !== shapedSource,
	);
	copy.kind = index;
	check("copy remains independent " + index, shapedSource.kind === 7);
}

const overwritten = { ...shapedSource, value: 29, next: 31 };
check(
	"overwrite and append",
	Object.keys(overwritten).join(",") === "kind,flags,generation,block,value,next" &&
		overwritten.value === 29 &&
		overwritten.next === 31,
);

const trailingEffects = [];
const trailingCopy = {
	...new Proxy(
		{ first: 1 },
		{
			ownKeys(target) {
				trailingEffects.push("keys");
				return Reflect.ownKeys(target);
			},
			getOwnPropertyDescriptor(target, key) {
				trailingEffects.push("descriptor:" + key);
				return Reflect.getOwnPropertyDescriptor(target, key);
			},
			get(target, key) {
				trailingEffects.push("get:" + key);
				gc();
				return target[key];
			},
		},
	),
	[(() => {
		trailingEffects.push("key");
		return "last";
	})()]: (() => {
		trailingEffects.push("value");
		gc();
		return shared;
	})(),
};
check(
	"first spread completes before trailing member evaluation",
	trailingEffects.join(",") === "keys,descriptor:first,get:first,key,value" &&
		trailingCopy.last === shared,
);
for (const source of [null, undefined]) {
	const copy = { ...source, retained: shared };
	check(
		"nullish initial spread keeps trailing fields",
		copy.retained === shared && Object.keys(copy).join(",") === "retained",
	);
}

const nullSource = Object.create(null);
nullSource.alpha = 1;
nullSource.beta = 2;
const nullCopy = { ...nullSource };
check(
	"null source prototype",
	Object.getPrototypeOf(nullCopy) === Object.prototype &&
		nullCopy.alpha === 1 &&
		nullCopy.beta === 2,
);

let setterCalls = 0;
Object.defineProperty(Object.prototype, "shadowed", {
	configurable: true,
	set() {
		setterCalls++;
	},
});
try {
	const setterCopy = { ...{ shadowed: 41 } };
	check(
		"inherited setter bypass",
		setterCalls === 0 &&
			Object.hasOwn(setterCopy, "shadowed") &&
			setterCopy.shadowed === 41,
	);
} finally {
	delete Object.prototype.shadowed;
}

const protoValue = { marker: 43 };
const protoCopy = { ...{ ["__proto__"]: protoValue } };
check(
	"__proto__ remains data",
	Object.getPrototypeOf(protoCopy) === Object.prototype &&
		Object.hasOwn(protoCopy, "__proto__") &&
		protoCopy.__proto__ === protoValue,
);

const frozenSource = Object.freeze({ frozen: 47, retained: shared });
for (let index = 0; index < 32; index++) {
	const frozenCopy = { ...frozenSource };
	const frozenDescriptor = Object.getOwnPropertyDescriptor(frozenCopy, "frozen");
	check(
		"frozen source normalization " + index,
		frozenCopy.frozen === 47 &&
			frozenCopy.retained === shared &&
			frozenDescriptor.writable === true &&
			frozenDescriptor.enumerable === true &&
			frozenDescriptor.configurable === true,
	);
}

const symbol = Symbol("spread");
let getterCalls = 0;
const descriptorSource = { 0: "zero", plain: "plain", [symbol]: "symbol" };
Object.defineProperty(descriptorSource, "observed", {
	enumerable: true,
	get() {
		getterCalls++;
		return "getter";
	},
});
Object.defineProperty(descriptorSource, "hidden", {
	enumerable: false,
	value: "hidden",
});
const descriptorCopy = { ...descriptorSource };
check(
	"descriptor fallback",
	getterCalls === 1 &&
		descriptorCopy[0] === "zero" &&
		descriptorCopy.plain === "plain" &&
		descriptorCopy.observed === "getter" &&
		descriptorCopy[symbol] === "symbol" &&
		!("hidden" in descriptorCopy),
);

const thrown = new Error("spread getter");
const throwingSource = {};
Object.defineProperty(throwingSource, "value", {
	enumerable: true,
	get() {
		throw thrown;
	},
});
let caught;
try {
	({ ...throwingSource });
} catch (error) {
	caught = error;
}
check("throwing getter fallback", caught === thrown);

const spreadEffects = [];
const spreadTarget = { first: 1, removed: 2, changed: 3 };
const spreadProxy = new Proxy(spreadTarget, {
	ownKeys() {
		spreadEffects.push("keys");
		return ["first", "removed", "changed"];
	},
	getOwnPropertyDescriptor(target, key) {
		spreadEffects.push("descriptor:" + key);
		return Reflect.getOwnPropertyDescriptor(target, key);
	},
	get(target, key) {
		spreadEffects.push("get:" + key);
		if (key === "first") {
			delete target.removed;
			target.changed = 4;
			target.added = 5;
		}
		return Reflect.get(target, key);
	},
});
const proxyCopy = { ...spreadProxy };
check(
	"Proxy spread snapshots keys and reads current descriptors",
	JSON.stringify(spreadEffects) ===
		'["keys","descriptor:first","get:first","descriptor:removed","descriptor:changed","get:changed"]' &&
		JSON.stringify(proxyCopy) === '{"first":1,"changed":4}',
);

const revokedSpread = Proxy.revocable({}, {});
revokedSpread.revoke();
caught = undefined;
try {
	({ ...revokedSpread.proxy });
} catch (error) {
	caught = error;
}
check("revoked Proxy spread throws", caught instanceof TypeError);

const nonempty = { prefix: 53, ...shapedSource };
check("nonempty target fallback", nonempty.prefix === 53 && nonempty.value === shared);

const wideSource = {};
for (let index = 0; index < 40; index++) wideSource["field-" + index] = index;
const wideCopy = { ...wideSource };
check(
	"wide fallback",
	Object.keys(wideCopy).length === 40 &&
		wideCopy["field-0"] === 0 &&
		wideCopy["field-39"] === 39,
);

function makeSourceAfterGc() {
	gc();
	return { left: { value: 59 }, right: { value: 61 } };
}
const barrierCopy = { ...makeSourceAfterGc() };
gc();
check(
	"old target retains young values",
	barrierCopy.left.value === 59 && barrierCopy.right.value === 61,
);

function copyDynamic(source, extra) {
	return { ...source, extra };
}
const layouts = [
	{ alpha: shared, beta: 3 },
	{ beta: 5, alpha: shared, gamma: 7 },
	Object.freeze({ alpha: shared, beta: 11 }),
];
for (let index = 0; index < 96; index++) {
	const source = layouts[index % layouts.length];
	const copy = copyDynamic(source, index);
	check(
		"mixed shapes retain independent values",
		copy !== source &&
			copy.alpha === shared &&
			copy.beta === source.beta &&
			copy.extra === index &&
			Object.keys(copy).join(",") === Object.keys(source).concat("extra").join(","),
	);
}

const getterOrder = [];
const orderedSymbol = Symbol("ordered");
const orderedSource = {
	get later() {
		getterOrder.push("later");
		gc();
		return shared;
	},
	get 9() {
		getterOrder.push("9");
		return 9;
	},
	get 2() {
		getterOrder.push("2");
		return 2;
	},
	get [orderedSymbol]() {
		getterOrder.push("symbol");
		return 13;
	},
};
Object.defineProperty(orderedSource, "hidden", { value: 17 });
function copyAcrossGetter(source, value) {
	const survivor = { nested: { value } };
	const result = { ...source, extra: survivor };
	gc();
	return result;
}
const orderedCopy = copyAcrossGetter(orderedSource, 19);
check(
	"dynamic getters run once in own-key order across collection",
	getterOrder.join(",") === "2,9,later,symbol" &&
		orderedCopy.later === shared &&
		orderedCopy[orderedSymbol] === 13 &&
		orderedCopy.extra.nested.value === 19 &&
		!("hidden" in orderedCopy) &&
		Reflect.ownKeys(orderedCopy).map(String).join(",") ===
			"2,9,later,extra,Symbol(ordered)",
);

console.log("object-spread-shaped PASS " + passed + "/" + passed);
