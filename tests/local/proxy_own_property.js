const forceGc = globalThis.__mal_collect_garbage;
const results = [];

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

const descriptorOrder = [];
const descriptor = {};
for (const [name, value] of [
	["enumerable", true],
	["configurable", true],
	["value", "live-value"],
	["writable", true],
]) {
	Object.defineProperty(descriptor, name, {
		get() {
			descriptorOrder.push(name);
			forceGc();
			return value;
		},
	});
}
const gcDescriptorProxy = new Proxy(
	{ x: 1 },
	{
		getOwnPropertyDescriptor() {
			return descriptor;
		},
	},
);
const gcDescriptor = Object.getOwnPropertyDescriptor(gcDescriptorProxy, "x");
check(
	"descriptor result and parsed fields survive GC",
	descriptorOrder.join("|") === "enumerable|configurable|value|writable" &&
		gcDescriptor.value === "live-value" &&
		gcDescriptor.writable &&
		gcDescriptor.enumerable &&
		gcDescriptor.configurable,
);

const descriptorProxyOrder = [];
const descriptorProxy = new Proxy(
	{},
	{
		has(target, key) {
			descriptorProxyOrder.push("has:" + key);
			return key === "value" || key === "configurable";
		},
		get(target, key) {
			descriptorProxyOrder.push("get:" + key);
			return key === "value" ? 9 : true;
		},
	},
);
const parsedProxyDescriptor = Object.getOwnPropertyDescriptor(
	new Proxy(
		{ x: 1 },
		{
			getOwnPropertyDescriptor() {
				return descriptorProxy;
			},
		},
	),
	"x",
);
check(
	"ToPropertyDescriptor uses proxy HasProperty and Get in order",
	descriptorProxyOrder.join("|") ===
		"has:enumerable|has:configurable|get:configurable|has:value|get:value|has:writable|has:get|has:set" &&
		parsedProxyDescriptor.value === 9 &&
		parsedProxyDescriptor.configurable,
);

const defineOrder = [];
const definedValue = { retained: true };
const defineDescriptor = new Proxy(
	{},
	{
		has(target, key) {
			defineOrder.push("has:" + key);
			return key === "value" || key === "writable";
		},
		get(target, key) {
			defineOrder.push("get:" + key);
			forceGc();
			return key === "value" ? definedValue : true;
		},
	},
);
const defineTarget = {};
Object.defineProperty(defineTarget, "x", defineDescriptor);
check(
	"Object.defineProperty uses rooted proxy-aware ToPropertyDescriptor",
	defineOrder.join("|") ===
		"has:enumerable|has:configurable|has:value|get:value|has:writable|get:writable|has:get|has:set" &&
		defineTarget.x === definedValue &&
		Object.getOwnPropertyDescriptor(defineTarget, "x").writable,
);

const descriptorMarker = {};
const abruptDescriptor = {};
Object.defineProperty(abruptDescriptor, "enumerable", {
	get() {
		forceGc();
		throw descriptorMarker;
	},
});
let descriptorAbruptPreserved = false;
try {
	Object.getOwnPropertyDescriptor(
		new Proxy(
			{},
			{
				getOwnPropertyDescriptor() {
					return abruptDescriptor;
				},
			},
		),
		"x",
	);
} catch (error) {
	descriptorAbruptPreserved = error === descriptorMarker;
}
check("descriptor getter abrupt completion is preserved", descriptorAbruptPreserved);

check(
	"array non-configurable length is enforced by ownKeys",
	throwsTypeError(() => Reflect.ownKeys(new Proxy([], { ownKeys: () => [] }))) &&
		Reflect.ownKeys(new Proxy([], { ownKeys: () => ["length"] })).join("|") === "length",
);

const fixedArray = [];
Object.preventExtensions(fixedArray);
check(
	"non-extensible exotic target rejects extra ownKeys",
	throwsTypeError(() =>
		Reflect.ownKeys(new Proxy(fixedArray, { ownKeys: () => ["length", "extra"] })),
	),
);

let indexedGets = 0;
const keyList = { length: 1 };
Object.defineProperty(keyList, 0, {
	get() {
		indexedGets++;
		return "once";
	},
});
const onceKeys = Reflect.ownKeys(new Proxy({}, { ownKeys: () => keyList }));
check(
	"ownKeys trap-result indexed getters are read once",
	indexedGets === 1 && onceKeys.join("|") === "once",
);

const nestedDescriptorMarker = {};
const nestedDescriptorTarget = new Proxy(
	{},
	{
		getOwnPropertyDescriptor() {
			throw nestedDescriptorMarker;
		},
	},
);
let nestedDescriptorAbrupt = false;
try {
	Object.getOwnPropertyDescriptor(
		new Proxy(nestedDescriptorTarget, {
			getOwnPropertyDescriptor() {
				return { value: 1, writable: true, enumerable: true, configurable: true };
			},
		}),
		"x",
	);
} catch (error) {
	nestedDescriptorAbrupt = error === nestedDescriptorMarker;
}
check("nested target descriptor abrupt completion propagates", nestedDescriptorAbrupt);

const nestedOwnKeysMarker = {};
const nestedOwnKeysTarget = new Proxy(
	{},
	{
		ownKeys() {
			throw nestedOwnKeysMarker;
		},
	},
);
let nestedOwnKeysAbrupt = false;
try {
	Reflect.ownKeys(new Proxy(nestedOwnKeysTarget, { ownKeys: () => [] }));
} catch (error) {
	nestedOwnKeysAbrupt = error === nestedOwnKeysMarker;
}
check("nested target ownKeys abrupt completion propagates", nestedOwnKeysAbrupt);

const nestedExtensibleMarker = {};
const nestedExtensibleTarget = new Proxy(
	{},
	{
		isExtensible() {
			throw nestedExtensibleMarker;
		},
	},
);
let nestedExtensibleAbrupt = false;
try {
	Reflect.ownKeys(new Proxy(nestedExtensibleTarget, { ownKeys: () => [] }));
} catch (error) {
	nestedExtensibleAbrupt = error === nestedExtensibleMarker;
}
check("nested target IsExtensible abrupt completion propagates", nestedExtensibleAbrupt);

const nestedArray = new Proxy([], {});
check(
	"nested proxy target enforces exotic non-configurable keys",
	throwsTypeError(() => Reflect.ownKeys(new Proxy(nestedArray, { ownKeys: () => [] }))),
);

let descriptorRevocable;
let descriptorTrapThis = false;
const descriptorHandler = {};
Object.defineProperty(descriptorHandler, "getOwnPropertyDescriptor", {
	get() {
		descriptorRevocable.revoke();
		forceGc();
		return function () {
			descriptorTrapThis = this === descriptorHandler;
			return { value: 1, writable: true, enumerable: true, configurable: true };
		};
	},
});
descriptorRevocable = Proxy.revocable({ x: 1 }, descriptorHandler);
const snapshottedDescriptor = Object.getOwnPropertyDescriptor(
	descriptorRevocable.proxy,
	"x",
);
check(
	"descriptor operation snapshots target and handler before GetMethod",
	descriptorTrapThis && snapshottedDescriptor.value === 1,
);

let ownKeysRevocable;
let ownKeysTrapThis = false;
const ownKeysHandler = {};
Object.defineProperty(ownKeysHandler, "ownKeys", {
	get() {
		ownKeysRevocable.revoke();
		forceGc();
		return function () {
			ownKeysTrapThis = this === ownKeysHandler;
			return ["x"];
		};
	},
});
ownKeysRevocable = Proxy.revocable({ x: 1 }, ownKeysHandler);
check(
	"ownKeys snapshots target and handler before GetMethod",
	Reflect.ownKeys(ownKeysRevocable.proxy).join("|") === "x" && ownKeysTrapThis,
);

function revokingMutation(trapName, invoke) {
	let revocable;
	let trapThis = false;
	let trapTarget = false;
	const target = { x: 1 };
	const handler = {};
	Object.defineProperty(handler, trapName, {
		get() {
			revocable.revoke();
			forceGc();
			return function (seenTarget) {
				trapThis = this === handler;
				trapTarget = seenTarget === target;
				return true;
			};
		},
	});
	revocable = Proxy.revocable(target, handler);
	return invoke(revocable.proxy) && trapThis && trapTarget;
}

check(
	"set snapshots rooted target and handler before GetMethod",
	revokingMutation("set", (proxy) => Reflect.set(proxy, "x", 2)),
);
check(
	"delete snapshots rooted target and handler before GetMethod",
	revokingMutation("deleteProperty", (proxy) => Reflect.deleteProperty(proxy, "x")),
);
check(
	"defineProperty snapshots rooted target and handler before GetMethod",
	revokingMutation("defineProperty", (proxy) =>
		Reflect.defineProperty(proxy, "x", {
			value: 2,
			writable: true,
			enumerable: true,
			configurable: true,
		}),
	),
);

const nestedGetTarget = new Proxy(
	{ x: 1 },
	{
		getOwnPropertyDescriptor() {
			forceGc();
			return { value: 1, writable: true, enumerable: true, configurable: true };
		},
	},
);
const nestedGetResult = new Proxy(nestedGetTarget, {
	get() {
		return { retained: "across-target-descriptor" };
	},
}).x;
check(
	"get trap result survives nested target descriptor GC",
	nestedGetResult.retained === "across-target-descriptor",
);

function untouchedOwnKeysFunction() {}
check(
	"untouched script-function prototype participates in ownKeys",
	Reflect.ownKeys(new Proxy(untouchedOwnKeysFunction, {})).join("|") ===
		"length|name|prototype",
);

function untouchedDescriptorFunction() {}
const untouchedDescriptorProxy = new Proxy(untouchedDescriptorFunction, {});
const untouchedPrototypeDescriptor = Object.getOwnPropertyDescriptor(
	untouchedDescriptorProxy,
	"prototype",
);
check(
	"untouched script-function prototype has an own descriptor",
	typeof untouchedPrototypeDescriptor.value === "object" &&
		untouchedPrototypeDescriptor.writable &&
		!untouchedPrototypeDescriptor.enumerable &&
		!untouchedPrototypeDescriptor.configurable,
);

function untouchedInvariantFunction() {}
check(
	"untouched script-function prototype is enforced as non-configurable",
	throwsTypeError(() =>
		Object.getOwnPropertyDescriptor(
			new Proxy(untouchedInvariantFunction, {
				getOwnPropertyDescriptor() {
					return undefined;
				},
			}),
			"prototype",
		),
	),
);

const stringWrapper = new String("a");
stringWrapper[3] = "d";
stringWrapper[2] = "c";
const wrappedProxy = new Proxy(stringWrapper, {});
check(
	"String-wrapper synthetic and ordinary numeric keys are merged",
	Reflect.ownKeys(wrappedProxy).join("|") === "0|2|3|length" &&
		Object.getOwnPropertyDescriptor(wrappedProxy, "2").value === "c" &&
		Object.getOwnPropertyDescriptor(wrappedProxy, "3").value === "d",
);

const frozenTarget = {};
Object.defineProperty(frozenTarget, "x", {
	value: 1,
	writable: false,
	enumerable: true,
	configurable: false,
});
check(
	"proxy descriptor compatibility rejects a changed frozen value",
	throwsTypeError(() =>
		Object.getOwnPropertyDescriptor(
			new Proxy(frozenTarget, {
				getOwnPropertyDescriptor() {
					return {
						value: 2,
						writable: false,
						enumerable: true,
						configurable: false,
					};
				},
			}),
			"x",
		),
	),
);

check(
	"completed proxy descriptor defaults participate in compatibility",
	throwsTypeError(() =>
		Object.getOwnPropertyDescriptor(
			new Proxy(frozenTarget, {
				getOwnPropertyDescriptor() {
					return { value: 1, writable: false, configurable: false };
				},
			}),
			"x",
		),
	),
);

const fixedGetter = function () {
	return 1;
};
const fixedAccessorTarget = {};
Object.defineProperty(fixedAccessorTarget, "x", {
	get: fixedGetter,
	enumerable: true,
	configurable: false,
});
check(
	"proxy descriptor compatibility checks fixed accessor identity",
	throwsTypeError(() =>
		Object.getOwnPropertyDescriptor(
			new Proxy(fixedAccessorTarget, {
				getOwnPropertyDescriptor() {
					return {
						get() {
							return 2;
						},
						enumerable: true,
						configurable: false,
					};
				},
			}),
			"x",
		),
	),
);

const writableFixedTarget = {};
Object.defineProperty(writableFixedTarget, "x", {
	value: 1,
	writable: true,
	configurable: false,
});
check(
	"proxy descriptor invariant rejects writable-to-false report",
	throwsTypeError(() =>
		Object.getOwnPropertyDescriptor(
			new Proxy(writableFixedTarget, {
				getOwnPropertyDescriptor() {
					return { value: 1, writable: false, configurable: false };
				},
			}),
			"x",
		),
	),
);

const nonExtensibleTarget = {};
Object.preventExtensions(nonExtensibleTarget);
check(
	"proxy cannot report a new descriptor on a non-extensible target",
	throwsTypeError(() =>
		Object.getOwnPropertyDescriptor(
			new Proxy(nonExtensibleTarget, {
				getOwnPropertyDescriptor() {
					return { value: 1, configurable: true };
				},
			}),
			"x",
		),
	),
);

function dynamicProxyKey(suffix) {
	return {
		[Symbol.toPrimitive]() {
			return ["rooted", suffix].join("-");
		},
	};
}

const rootedKeySeen = [];
const rootedKeyTarget = {
	"rooted-get": 11,
	"rooted-delete": 12,
	"rooted-own": 13,
};
const rootedKeyHandler = {};
for (const [trapName, trap] of [
	["get", (target, key) => (rootedKeySeen.push("get:" + key), target[key])],
	["set", (target, key) => (rootedKeySeen.push("set:" + key), true)],
	["deleteProperty", (target, key) => (rootedKeySeen.push("delete:" + key), true)],
	["defineProperty", (target, key) => (rootedKeySeen.push("define:" + key), true)],
	[
		"getOwnPropertyDescriptor",
		(target, key) => {
			rootedKeySeen.push("own:" + key);
			return { value: 13, writable: true, enumerable: true, configurable: true };
		},
	],
]) {
	Object.defineProperty(rootedKeyHandler, trapName, {
		get() {
			forceGc();
			return trap;
		},
	});
}
const rootedKeyProxy = new Proxy(rootedKeyTarget, rootedKeyHandler);
const rootedGet = Reflect.get(rootedKeyProxy, dynamicProxyKey("get"));
const rootedSet = Reflect.set(rootedKeyProxy, dynamicProxyKey("set"), 1);
const rootedDelete = Reflect.deleteProperty(rootedKeyProxy, dynamicProxyKey("delete"));
const rootedDefine = Reflect.defineProperty(rootedKeyProxy, dynamicProxyKey("define"), {
	value: 1,
	configurable: true,
});
const rootedOwn = Reflect.getOwnPropertyDescriptor(
	rootedKeyProxy,
	dynamicProxyKey("own"),
);
check(
	"dynamically coerced Proxy keys survive trap lookup GC",
	rootedGet === 11 &&
		rootedSet &&
		rootedDelete &&
		rootedDefine &&
		rootedOwn.value === 13 &&
		rootedKeySeen.join("|") ===
			"get:rooted-get|set:rooted-set|delete:rooted-delete|define:rooted-define|own:rooted-own",
);

const ownKeysGcTarget = new Proxy(
	{},
	{
		ownKeys() {
			forceGc();
			return [["rooted", "ownKeys"].join("-")];
		},
		getOwnPropertyDescriptor() {
			forceGc();
			return { configurable: true };
		},
	},
);
check(
	"dynamic ownKeys values survive nested target GC",
	Reflect.ownKeys(
		new Proxy(ownKeysGcTarget, {
			ownKeys() {
				return [["rooted", "ownKeys"].join("-")];
			},
		}),
	).join("|") === "rooted-ownKeys",
);

const ownKeysInvariantOrder = [];
const orderedOwnKeysTarget = new Proxy(
	{},
	{
		ownKeys() {
			ownKeysInvariantOrder.push("target-ownKeys");
			return [];
		},
		isExtensible(target) {
			ownKeysInvariantOrder.push("target-isExtensible");
			return Reflect.isExtensible(target);
		},
	},
);
Reflect.ownKeys(
	new Proxy(orderedOwnKeysTarget, {
		ownKeys() {
			ownKeysInvariantOrder.push("outer-ownKeys");
			return [];
		},
	}),
);
check(
	"ownKeys gets target keys before IsExtensible",
	ownKeysInvariantOrder.join("|") === "outer-ownKeys|target-ownKeys|target-isExtensible",
);

let deeplyNestedProxy = {};
for (let i = 0; i < 400; i++) deeplyNestedProxy = new Proxy(deeplyNestedProxy, {});
let nestedDispatchGuarded = false;
try {
	Reflect.ownKeys(deeplyNestedProxy);
} catch (error) {
	nestedDispatchGuarded = error instanceof RangeError;
}
check("deep nested Proxy dispatch is guarded", nestedDispatchGuarded);

let deeplyNestedExtensibleProxy = {};
for (let i = 0; i < 400; i++) {
	deeplyNestedExtensibleProxy = new Proxy(deeplyNestedExtensibleProxy, {});
}
let nestedExtensibleGuarded = false;
try {
	Reflect.isExtensible(deeplyNestedExtensibleProxy);
} catch (error) {
	nestedExtensibleGuarded = error instanceof RangeError;
}
check("deep nested Proxy IsExtensible dispatch is guarded", nestedExtensibleGuarded);

const defineAbruptMarker = {};
let defineTrapLookedUp = false;
const defineAbruptHandler = {};
Object.defineProperty(defineAbruptHandler, "defineProperty", {
	get() {
		defineTrapLookedUp = true;
		return () => true;
	},
});
const defineAbruptValue = {};
Object.defineProperty(defineAbruptValue, "enumerable", {
	get() {
		forceGc();
		throw defineAbruptMarker;
	},
});
let defineAbruptPreserved = false;
try {
	Reflect.defineProperty(new Proxy({}, defineAbruptHandler), "x", defineAbruptValue);
} catch (error) {
	defineAbruptPreserved = error === defineAbruptMarker;
}
check(
	"Proxy define converts descriptor before trap lookup and preserves abrupt completion",
	defineAbruptPreserved && !defineTrapLookedUp,
);

const acceptsDefine = { defineProperty: () => true };
const missingDefineTarget = {};
const fixedDefineTarget = {};
Object.defineProperty(fixedDefineTarget, "x", {
	value: 1,
	writable: false,
	configurable: false,
});
const fixedWritableDefineTarget = {};
Object.defineProperty(fixedWritableDefineTarget, "x", {
	value: 1,
	writable: true,
	configurable: false,
});
const configurableDefineTarget = { x: 1 };
const sealedDefineTarget = {};
Object.preventExtensions(sealedDefineTarget);
check(
	"Proxy define enforces missing-property configurability and extensibility",
	throwsTypeError(() =>
		Reflect.defineProperty(new Proxy(missingDefineTarget, acceptsDefine), "x", {
			value: 1,
			configurable: false,
		}),
	) &&
		throwsTypeError(() =>
			Reflect.defineProperty(new Proxy(sealedDefineTarget, acceptsDefine), "x", {
				value: 1,
				configurable: true,
			}),
		),
);
check(
	"Proxy define enforces non-configurable and frozen compatibility",
	throwsTypeError(() =>
		Reflect.defineProperty(new Proxy(configurableDefineTarget, acceptsDefine), "x", {
			configurable: false,
		}),
	) &&
		throwsTypeError(() =>
			Reflect.defineProperty(new Proxy(fixedDefineTarget, acceptsDefine), "x", {
				value: 2,
			}),
		) &&
		throwsTypeError(() =>
			Reflect.defineProperty(new Proxy(fixedWritableDefineTarget, acceptsDefine), "x", {
				writable: false,
			}),
		) &&
		Reflect.defineProperty(new Proxy(fixedDefineTarget, acceptsDefine), "x", {
			value: 1,
		}),
);

let passed = 0;
for (const [name, ok] of results) {
	if (ok) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
