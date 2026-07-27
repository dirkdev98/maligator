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

function integrityAbrupt(trapName) {
	const marker = {};
	const target = { x: 1 };
	const handler = {
		preventExtensions(seenTarget) {
			Reflect.preventExtensions(seenTarget);
			return true;
		},
	};
	handler[trapName] = function () {
		forceGc();
		throw marker;
	};
	try {
		Object.freeze(new Proxy(target, handler));
	} catch (error) {
		return error === marker;
	}
	return false;
}

check("freeze preserves ownKeys abrupt completion", integrityAbrupt("ownKeys"));
check(
	"freeze preserves defineProperty abrupt completion",
	integrityAbrupt("defineProperty"),
);

const integrityOrder = [];
const integrityDescriptors = {};
const integrityTarget = { data: 1 };
Object.defineProperty(integrityTarget, "accessor", {
	get() {
		return 2;
	},
	configurable: true,
});
const integrityProxy = new Proxy(integrityTarget, {
	preventExtensions(target) {
		integrityOrder.push("preventExtensions");
		return Reflect.preventExtensions(target);
	},
	ownKeys(target) {
		integrityOrder.push("ownKeys");
		return Reflect.ownKeys(target);
	},
	getOwnPropertyDescriptor(target, key) {
		integrityOrder.push("getOwnPropertyDescriptor:" + key);
		return Reflect.getOwnPropertyDescriptor(target, key);
	},
	defineProperty(target, key, descriptor) {
		integrityOrder.push("defineProperty:" + key);
		integrityDescriptors[key] = descriptor;
		return Reflect.defineProperty(target, key, descriptor);
	},
});
Object.freeze(integrityProxy);
check(
	"freeze uses ordered internal methods and partial descriptors",
	integrityOrder.join("|") ===
		"preventExtensions|ownKeys|getOwnPropertyDescriptor:data|defineProperty:data|getOwnPropertyDescriptor:accessor|defineProperty:accessor" &&
		integrityDescriptors.data.writable === false &&
		integrityDescriptors.data.configurable === false &&
		!("value" in integrityDescriptors.data) &&
		integrityDescriptors.accessor.configurable === false &&
		!("get" in integrityDescriptors.accessor),
);
check(
	"TestIntegrityLevel observes proxy internal methods",
	Object.isFrozen(integrityProxy) && Object.isSealed(integrityProxy),
);

const nestedPreventMarker = {};
let nestedPreventAbrupt = false;
try {
	Object.seal(
		new Proxy(
			new Proxy(
				{},
				{
					isExtensible() {
						throw nestedPreventMarker;
					},
				},
			),
			{
				preventExtensions() {
					return true;
				},
			},
		),
	);
} catch (error) {
	nestedPreventAbrupt = error === nestedPreventMarker;
}
check(
	"preventExtensions invariant preserves nested IsExtensible abrupt completion",
	nestedPreventAbrupt,
);

function reviverProxyAbrupt(kind) {
	const marker = {};
	const handler = {};
	handler[kind] = function () {
		forceGc();
		throw marker;
	};
	const replacement = new Proxy({ item: 1 }, handler);
	try {
		JSON.parse('["replace",null]', function (key, value) {
			if (value === "replace") this[1] = replacement;
			if (kind === "deleteProperty" && key === "item") return undefined;
			return value;
		});
	} catch (error) {
		return error === marker;
	}
	return false;
}

check("JSON.parse reviver ownKeys abrupt", reviverProxyAbrupt("ownKeys"));
check("JSON.parse reviver defineProperty abrupt", reviverProxyAbrupt("defineProperty"));
check("JSON.parse reviver deleteProperty abrupt", reviverProxyAbrupt("deleteProperty"));

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

const deleteAbruptMarker = {};
let deleteAbruptPreserved = false;
try {
	(function (proxy) {
		"use strict";
		delete proxy.x;
	})(
		new Proxy(
			{},
			{
				deleteProperty() {
					forceGc();
					throw deleteAbruptMarker;
				},
			},
		),
	);
} catch (error) {
	deleteAbruptPreserved = error === deleteAbruptMarker;
}
check("strict delete preserves the trap abrupt completion", deleteAbruptPreserved);

const nestedStringDelete = new Proxy(new Proxy(new String("str"), {}), {
	deleteProperty: null,
});
check(
	"null delete trap forwards through proxies to String exotic properties",
	!Reflect.deleteProperty(nestedStringDelete, "length") &&
		throwsTypeError(() => {
			"use strict";
			delete nestedStringDelete[0];
		}),
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

const nestedDefineString = new String("str");
const nestedDefineStringProxy = new Proxy(
	new Proxy(nestedDefineString, { defineProperty: null }),
	{ defineProperty: undefined },
);
check(
	"missing nested Proxy define traps forward to String exotic properties",
	Reflect.defineProperty(nestedDefineStringProxy, "4", { value: 4 }) &&
		nestedDefineString[4] === 4 &&
		throwsTypeError(() =>
			Object.defineProperty(nestedDefineStringProxy, "0", { value: "x" }),
		),
);

function nestedDefineFunction() {}
const nestedDefineFunctionProxy = new Proxy(new Proxy(nestedDefineFunction, {}), {});
check(
	"missing nested Proxy define traps preserve lazy function prototype invariants",
	throwsTypeError(() =>
		Object.defineProperty(nestedDefineFunctionProxy, "prototype", {
			set() {},
		}),
	),
);

const prototypeSetCalls = [];
const prototypeSetHandler = {
	set(target, key, value, receiver) {
		prototypeSetCalls.push([this, target, key, value, receiver]);
		return true;
	},
};
const prototypeSetTarget = {};
const prototypeSetProxy = new Proxy(prototypeSetTarget, prototypeSetHandler);
const prototypeSetObject = Object.create(prototypeSetProxy);
const prototypeSetArray = [];
Object.setPrototypeOf(prototypeSetArray, prototypeSetProxy);
prototypeSetObject.value = 11;
prototypeSetArray[0] = 12;
check(
	"ordinary Set dispatches Proxy prototypes with the original receiver",
	prototypeSetCalls.length === 2 &&
		prototypeSetCalls[0][0] === prototypeSetHandler &&
		prototypeSetCalls[0][1] === prototypeSetTarget &&
		prototypeSetCalls[0][2] === "value" &&
		prototypeSetCalls[0][3] === 11 &&
		prototypeSetCalls[0][4] === prototypeSetObject &&
		prototypeSetCalls[1][0] === prototypeSetHandler &&
		prototypeSetCalls[1][1] === prototypeSetTarget &&
		prototypeSetCalls[1][2] === "0" &&
		prototypeSetCalls[1][3] === 12 &&
		prototypeSetCalls[1][4] === prototypeSetArray,
);

let inheritedSetterReceiver;
const inheritedSetterTarget = {
	set value(next) {
		forceGc();
		inheritedSetterReceiver = this;
		this.seen = next;
	},
};
const inheritedSetterObject = Object.create(
	new Proxy(new Proxy(inheritedSetterTarget, {}), { set: undefined }),
);
inheritedSetterObject.value = 13;
check(
	"missing nested Proxy set traps forward the original receiver",
	inheritedSetterReceiver === inheritedSetterObject && inheritedSetterObject.seen === 13,
);

const prototypeHasCalls = [];
const prototypeHasHandler = {
	has(target, key) {
		forceGc();
		prototypeHasCalls.push([this, target, key]);
		return key === "present";
	},
};
const prototypeHasTarget = Object.create([]);
const prototypeHasProxy = new Proxy(prototypeHasTarget, prototypeHasHandler);
const prototypeHasObject = Object.create(prototypeHasProxy);
const prototypeHasArray = [];
Object.setPrototypeOf(prototypeHasArray, prototypeHasProxy);
check(
	"ordinary HasProperty dispatches Proxy prototypes and exotic target prototypes",
	"present" in prototypeHasObject &&
		!("0" in prototypeHasArray) &&
		"length" in new Proxy(Object.create(Array.prototype), {}) &&
		prototypeHasCalls.length === 2 &&
		prototypeHasCalls[0][0] === prototypeHasHandler &&
		prototypeHasCalls[0][1] === prototypeHasTarget &&
		prototypeHasCalls[0][2] === "present" &&
		prototypeHasCalls[1][2] === "0",
);

const rejectedPrototype = new Proxy({}, { set: () => false });
const sloppyRejected = Object.create(rejectedPrototype);
const reflectedRejected = !Reflect.set(sloppyRejected, "value", 1);
let strictRejected = false;
try {
	(function () {
		"use strict";
		Object.create(rejectedPrototype).value = 1;
	})();
} catch (error) {
	strictRejected = error instanceof TypeError;
}
check(
	"Proxy prototype Set rejection preserves boolean and strict PutValue behavior",
	reflectedRejected && !("value" in sloppyRejected) && strictRejected,
);

const proxySuperHome = {
	write() {
		super.forwarded = 14;
	},
};
Object.setPrototypeOf(
	proxySuperHome,
	new Proxy(
		{},
		{
			set(target, key, value, receiver) {
				Object.defineProperty(receiver, "superValue", {
					value: [key, value],
					configurable: true,
				});
				return true;
			},
		},
	),
);
const proxySuper = Object.create(proxySuperHome);
proxySuper.write();
check(
	"super assignment dispatches Proxy prototypes with derived receiver",
	proxySuper.superValue &&
		proxySuper.superValue[0] === "forwarded" &&
		proxySuper.superValue[1] === 14,
);

const fixedLengthReceiver = [];
Object.defineProperty(fixedLengthReceiver, "length", { writable: false });
check(
	"receiver array index creation honors non-writable length",
	!Reflect.set({}, "0", 1, fixedLengthReceiver) &&
		!("0" in fixedLengthReceiver) &&
		fixedLengthReceiver.length === 0,
);

const typedTarget = new Uint8Array(1);
Object.setPrototypeOf(typedTarget, { 1: "hidden", "-1": "hidden" });
const typedReceiver = {};
check(
	"typed array canonical indices use integer-indexed Set and HasProperty",
	"0" in typedTarget &&
		!("1" in typedTarget) &&
		!("-1" in typedTarget) &&
		Reflect.set(typedTarget, "0", 21, typedReceiver) &&
		typedReceiver[0] === 21 &&
		typedTarget[0] === 0 &&
		Reflect.set(typedTarget, "1", 22, typedReceiver) &&
		!("1" in typedReceiver) &&
		Reflect.set(typedTarget, "-1", 22, typedReceiver) &&
		!("-1" in typedReceiver) &&
		Reflect.set(typedTarget, "NaN", 23, typedReceiver) &&
		!("NaN" in typedReceiver),
);

const immutableTyped = new Uint8Array(new Uint8Array([7]).buffer.transferToImmutable());
const immutableDescriptor = Object.getOwnPropertyDescriptor(immutableTyped, "0");
const immutableReflectDescriptor = Reflect.getOwnPropertyDescriptor(immutableTyped, "0");
let immutableCoercions = 0;
const immutableValue = {
	valueOf() {
		immutableCoercions++;
		return 8;
	},
};
check(
	"immutable typed array indices expose fixed descriptors and reject Set",
	immutableDescriptor.value === 7 &&
		!immutableDescriptor.writable &&
		immutableDescriptor.enumerable &&
		!immutableDescriptor.configurable &&
		immutableReflectDescriptor.value === 7 &&
		!immutableReflectDescriptor.writable &&
		immutableReflectDescriptor.enumerable &&
		!immutableReflectDescriptor.configurable &&
		!Reflect.set(immutableTyped, "0", immutableValue) &&
		!Reflect.set(immutableTyped, "-1", immutableValue, {}) &&
		immutableCoercions === 0 &&
		immutableTyped[0] === 7 &&
		throwsTypeError(() => {
			"use strict";
			immutableTyped[0] = 8;
		}),
);
check(
	"immutable typed array indices accept only compatible redefinitions",
	Reflect.defineProperty(immutableTyped, "0", {}) &&
		Reflect.defineProperty(immutableTyped, "0", { value: 7 }) &&
		!Reflect.defineProperty(immutableTyped, "0", { value: 8 }) &&
		!Reflect.defineProperty(immutableTyped, "0", { writable: true }) &&
		!Reflect.defineProperty(immutableTyped, "0", { configurable: true }),
);

const receiverDescriptorTarget = { value: 1 };
const receiverDescriptor = {};
Object.defineProperty(receiverDescriptor, "value", {
	value: 2,
	writable: false,
	configurable: true,
});
check(
	"OrdinarySetWithOwnDescriptor respects receiver-side descriptors and primitives",
	!Reflect.set(receiverDescriptorTarget, "value", 3, receiverDescriptor) &&
		receiverDescriptor.value === 2 &&
		!Reflect.set(receiverDescriptorTarget, "value", 3, 1),
);

const revokedSetPrototype = Proxy.revocable({}, {});
const revokedSetObject = Object.create(revokedSetPrototype.proxy);
revokedSetPrototype.revoke();
check(
	"ordinary Set and HasProperty propagate Proxy prototype revocation",
	throwsTypeError(() => Reflect.set(revokedSetObject, "x", 1)) &&
		throwsTypeError(() => "x" in revokedSetObject),
);

const setPrototypeOrder = [];
const nestedPrototype = {};
const nestedPrototypeTarget = new Proxy(Object.create(nestedPrototype), {
	isExtensible() {
		forceGc();
		setPrototypeOrder.push("isExtensible");
		return false;
	},
	getPrototypeOf() {
		forceGc();
		setPrototypeOrder.push("getPrototypeOf");
		return nestedPrototype;
	},
});
Object.preventExtensions(nestedPrototypeTarget);
const nestedPrototypeHandler = {
	setPrototypeOf(target, prototype) {
		forceGc();
		setPrototypeOrder.push("setPrototypeOf");
		return (
			this === nestedPrototypeHandler &&
			target === nestedPrototypeTarget &&
			prototype === nestedPrototype
		);
	},
};
const nestedPrototypeProxy = new Proxy(nestedPrototypeTarget, nestedPrototypeHandler);
check(
	"Proxy SetPrototypeOf orders nested target internal methods under GC",
	Reflect.setPrototypeOf(nestedPrototypeProxy, nestedPrototype) &&
		setPrototypeOrder.join("|") === "setPrototypeOf|isExtensible|getPrototypeOf",
);

const setPrototypeAbrupt = {};
const abruptPrototypeTarget = new Proxy(
	{},
	{
		isExtensible() {
			forceGc();
			throw setPrototypeAbrupt;
		},
	},
);
const abruptPrototypeProxy = new Proxy(abruptPrototypeTarget, {
	setPrototypeOf() {
		return true;
	},
});
let observedSetPrototypeAbrupt;
try {
	Reflect.setPrototypeOf(abruptPrototypeProxy, null);
} catch (error) {
	observedSetPrototypeAbrupt = error;
}
check(
	"Proxy SetPrototypeOf preserves nested abrupt completion identity",
	observedSetPrototypeAbrupt === setPrototypeAbrupt,
);

const rejectedSetPrototype = new Proxy({}, { setPrototypeOf: () => false });
let rejectedObjectSetPrototype = false;
let rejectedProtoSetter = false;
try {
	Object.setPrototypeOf(rejectedSetPrototype, null);
} catch (error) {
	rejectedObjectSetPrototype = error instanceof TypeError;
}
try {
	rejectedSetPrototype.__proto__ = null;
} catch (error) {
	rejectedProtoSetter = error instanceof TypeError;
}
check(
	"Proxy SetPrototypeOf false is reflected or thrown by its caller",
	!Reflect.setPrototypeOf(rejectedSetPrototype, null) &&
		rejectedObjectSetPrototype &&
		rejectedProtoSetter,
);

const cyclePrototypeBase = {};
const cyclePrototypeChild = Object.create(cyclePrototypeBase);
check(
	"ordinary SetPrototypeOf rejects cycles without mutation",
	!Reflect.setPrototypeOf(cyclePrototypeBase, cyclePrototypeChild) &&
		Object.getPrototypeOf(cyclePrototypeBase) === Object.prototype,
);

let passed = 0;
for (const [name, ok] of results) {
	if (ok) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
