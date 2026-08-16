"use strict";

let checks = 0;
function ok(name, condition) {
	if (!condition) throw new Error("object-has-own-known failure: " + name);
	checks++;
}

function known(value, key) {
	return Object.hasOwn(value, key);
}

ok("own", known({ value: 1 }, "value"));
ok("inherited", !known(Object.create({ value: 1 }), "value"));
ok("string exotic", known("abc", 1));
ok(
	"missing arguments",
	(() => {
		try {
			known();
			return false;
		} catch (error) {
			return error instanceof TypeError;
		}
	})(),
);

let trapCalls = 0;
const proxy = new Proxy(
	{ value: 1 },
	{
		getOwnPropertyDescriptor(target, key) {
			trapCalls++;
			return Reflect.getOwnPropertyDescriptor(target, key);
		},
	},
);
ok("proxy trap", known(proxy, "value") && trapCalls === 1);

const key = {
	toString() {
		return "value";
	},
};
ok("key coercion", known({ value: 1 }, key));

function knownKeys(value) {
	return Object.keys(value);
}
ok("keys order", knownKeys({ 2: true, 1: true, later: true }).join(",") === "1,2,later");
ok("keys string exotic", knownKeys("abc").join(",") === "0,1,2");
let ownKeysCalls = 0;
const keysProxy = new Proxy(
	{ visible: 1 },
	{
		ownKeys(target) {
			ownKeysCalls++;
			return Reflect.ownKeys(target);
		},
	},
);
ok("keys proxy trap", knownKeys(keysProxy)[0] === "visible" && ownKeysCalls === 1);

function knownValues(value) {
	return Object.values(value);
}
let getterCalls = 0;
const getterValue = {
	get visible() {
		getterCalls++;
		return 17;
	},
};
Object.defineProperty(getterValue, "hidden", { value: 99, enumerable: false });
ok("values getter", knownValues(getterValue)[0] === 17 && getterCalls === 1);
let proxyGets = 0;
const valuesProxy = new Proxy(
	{ visible: 23 },
	{
		get(target, key, receiver) {
			proxyGets++;
			return Reflect.get(target, key, receiver);
		},
	},
);
ok("values proxy get", knownValues(valuesProxy)[0] === 23 && proxyGets === 1);

ok("check count", checks === 11);
console.log("object-has-own-known PASS");
