"use strict";

const collect = globalThis.__mal_collect_garbage || globalThis.gc;
let checks = 0;
function check(condition) {
	if (!condition) throw new Error("transient query check " + checks);
	checks++;
}
function key(value, trace) {
	return {
		[Symbol.toPrimitive](hint) {
			trace.push(hint);
			return value.slice(0, value.length - 1) + value.slice(-1);
		},
	};
}

const target = { present: 7, 12: 19 };
const symbol = Symbol("query");
target[symbol] = 23;
const trace = [];
const proxy = new Proxy(target, {
	get(object, name, receiver) {
		collect();
		trace.push("get:" + String(name));
		return Reflect.get(object, name, receiver);
	},
	has(object, name) {
		collect();
		trace.push("has:" + String(name));
		return Reflect.has(object, name);
	},
	getOwnPropertyDescriptor(object, name) {
		collect();
		trace.push("own:" + String(name));
		return Reflect.getOwnPropertyDescriptor(object, name);
	},
	deleteProperty(object, name) {
		collect();
		trace.push("delete:" + String(name));
		return Reflect.deleteProperty(object, name);
	},
});

for (let i = 0; i < 16; i++) {
	const name = "transient-missing-name-with-long-prefix-" + i;
	check(proxy[key(name, trace)] === undefined);
	check(Reflect.get(proxy, key(name, trace)) === undefined);
	check(!(key(name, trace) in proxy));
	check(!Reflect.has(proxy, key(name, trace)));
	check(!Object.hasOwn(proxy, key(name, trace)));
	check(!Object.prototype.hasOwnProperty.call(proxy, key(name, trace)));
	check(!Object.prototype.propertyIsEnumerable.call(proxy, key(name, trace)));
	check(Object.getOwnPropertyDescriptor(proxy, key(name, trace)) === undefined);
	check(Reflect.getOwnPropertyDescriptor(proxy, key(name, trace)) === undefined);
	check(delete proxy[key(name, trace)]);
	check(Reflect.deleteProperty(proxy, key(name, trace)));
	check(Object.prototype.__lookupGetter__.call(proxy, key(name, trace)) === undefined);
}
check(trace.filter((entry) => entry === "string").length === 16 * 12);
check(proxy[key("present", trace)] === 7);
check(proxy[key("12", trace)] === 19);
check(proxy[symbol] === 23);
check(
	Reflect.get(proxy, {
		[Symbol.toPrimitive]() {
			return symbol;
		},
	}) === 23,
);

const getterReceiver = { marker: 41 };
Object.defineProperty(target, "getter", {
	get() {
		collect();
		return this.marker;
	},
});
check(Reflect.get(proxy, key("getter", trace), getterReceiver) === 41);

let conversions = 0;
try {
	null[
		{
			toString() {
				conversions++;
				return "x";
			},
		}
	];
} catch (error) {
	check(error instanceof TypeError);
}
check(conversions === 0);
const thrown = {};
try {
	proxy[
		{
			[Symbol.toPrimitive]() {
				throw thrown;
			},
		}
	];
} catch (error) {
	check(error === thrown);
}

const base = { value: 5 };
const child = {
	__proto__: base,
	read(name) {
		return super[name];
	},
};
check(child.read(key("value", trace)) === 5);
check(child.read(key("another-long-transient-missing-name", trace)) === undefined);
console.log("transient-property-query PASS " + checks);
