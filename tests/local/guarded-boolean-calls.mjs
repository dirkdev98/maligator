function check(condition, label) {
	if (!condition) throw new Error(label);
}
function boolean(value, extra = () => {}) {
	return Boolean(value, extra());
}
function globalBoolean(value, extra = () => {}) {
	return globalThis.Boolean(value, extra());
}
function empty() {
	return Boolean();
}
function valueOf(value, extra = () => {}) {
	return (!!value).valueOf(extra());
}
function text(value, extra = () => {}) {
	return (!!value).toString(extra());
}
function* suspended(value) {
	return Boolean(value, yield 1);
}
const NativeBoolean = Boolean;
const prototype = NativeBoolean.prototype;
const globalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Boolean");
const revoked = Proxy.revocable({}, {});
revoked.revoke();
let coercions = 0;
const poison = {
	[Symbol.toPrimitive]() {
		coercions++;
		throw new Error("coerced");
	},
};
const values = [
	undefined,
	null,
	false,
	true,
	0,
	-0,
	NaN,
	Infinity,
	1,
	"",
	"a",
	0n,
	1n,
	Symbol(),
	{},
	new NativeBoolean(false),
	revoked.proxy,
	poison,
];
for (const value of values) {
	check(
		boolean(value) === !!value && globalBoolean(value) === !!value,
		"truthiness input",
	);
	check(valueOf(value) === !!value, "primitive Boolean identity");
	check(text(value) === (value ? "true" : "false"), "primitive Boolean text");
}
check(coercions === 0 && empty() === false, "noncoercing and omitted argument");
const marker = {};
for (const [owner, key, invoke, input, expected, receiver, count] of [
	[globalThis, "Boolean", boolean, poison, true, undefined, 2],
	[globalThis, "Boolean", globalBoolean, poison, true, globalThis, 2],
	[prototype, "valueOf", valueOf, 1, true, true, 1],
	[prototype, "toString", text, 1, "true", true, 1],
]) {
	const descriptor = Object.getOwnPropertyDescriptor(owner, key);
	const original = descriptor.value;
	let events = [];
	try {
		Object.defineProperty(owner, key, {
			configurable: true,
			get() {
				events.push("get");
				return original;
			},
		});
		check(
			invoke(input, () => {
				events.push("argument");
				Object.defineProperty(owner, key, {
					...descriptor,
					value: () => marker,
				});
				if (typeof gc === "function") gc();
			}) === expected,
			key + " captures callee before mutation and collection",
		);
		check(events.join() === "get,argument", key + " getter and argument order");
		for (const result of [marker, 0, null, undefined, 1n, Symbol(), "changed"]) {
			owner[key] = function () {
				check(
					this === receiver && arguments.length === count,
					key + " fallback call ABI",
				);
				return result;
			};
			check(invoke(input) === result, key + " arbitrary replacement result");
		}
		let applied = 0;
		owner[key] = new Proxy(original, {
			apply(target, thisValue, args) {
				applied++;
				check(thisValue === receiver && args.length === count, key + " proxy call ABI");
				return marker;
			},
		});
		check(invoke(input) === marker && applied === 1, key + " proxy trap");
		owner[key] = original.bind(false);
		check(
			invoke(input) === (key === "Boolean" ? true : key === "valueOf" ? false : "false"),
			key + " bound receiver",
		);
		owner[key] = 1;
		events = [];
		let caught;
		try {
			invoke(input, () => {
				events.push("argument");
				throw marker;
			});
		} catch (error) {
			caught = error;
		}
		check(
			caught === marker && events.join() === "argument",
			key + " argument throw before callable check",
		);
		Object.defineProperty(owner, key, {
			configurable: true,
			get() {
				throw marker;
			},
		});
		events = [];
		caught = undefined;
		try {
			invoke(input, () => events.push("argument"));
		} catch (error) {
			caught = error;
		}
		check(
			caught === marker && events.length === 0,
			key + " getter throw before arguments",
		);
		if (typeof $262 !== "undefined") {
			const foreign = $262.createRealm().global;
			Object.defineProperty(owner, key, {
				...descriptor,
				value: key === "Boolean" ? foreign.Boolean : foreign.Boolean.prototype[key],
			});
			check(invoke(input) === expected, key + " foreign builtin");
		}
	} finally {
		Object.defineProperty(owner, key, descriptor);
	}
}
try {
	const iterator = suspended(poison);
	check(iterator.next().value === 1, "suspend after loading callee");
	globalThis.Boolean = () => marker;
	if (typeof gc === "function") gc();
	check(iterator.next().value === true, "resume with original callee");
	check(empty() === marker, "omitted arguments on replacement");
	let caught;
	try {
		new Boolean();
	} catch (error) {
		caught = error;
	}
	check(caught instanceof TypeError, "replacement arrow remains nonconstructable");
} finally {
	Object.defineProperty(globalThis, "Boolean", globalDescriptor);
}
for (const key of ["valueOf", "toString"]) {
	const method = prototype[key];
	for (const receiver of [
		null,
		undefined,
		{},
		1,
		"a",
		revoked.proxy,
		new Proxy(new NativeBoolean(true), {}),
	]) {
		let caught;
		try {
			Reflect.apply(method, receiver, []);
		} catch (error) {
			caught = error;
		}
		check(caught instanceof TypeError, key + " wrong brand remains exceptional");
	}
	check(
		Reflect.apply(method, new NativeBoolean(false), []) ===
			(key === "valueOf" ? false : "false"),
		key + " wrapper brand fallback",
	);
}
check(coercions === 0, "no user coercions");
console.log("boolean guards passed");
