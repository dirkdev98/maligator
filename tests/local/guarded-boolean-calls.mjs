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

function objectBoolean(value, extra = () => {}) {
	const input = { value };
	return Boolean(input, extra());
}
function positiveBoolean(value, extra = () => {}) {
	const input = (value >>> 0) + 1;
	return Boolean(input, extra());
}
function unsignedBoolean(value, extra = () => {}) {
	const input = value >>> 0;
	return Boolean(input, extra());
}
function stringBoolean(value, extra = () => {}) {
	const input = "" + value;
	return Boolean(input, extra());
}
function optionalBoolean(value, flag, extra = () => {}) {
	const input = flag ? +value : undefined;
	return Boolean(input, extra());
}
function numberBoolean(value, flag) {
	const input = flag ? +value : !!value;
	return Boolean(input);
}
function stringBigintBoolean(value, flag) {
	const input = flag ? "" + value : 0n;
	return Boolean(input);
}
function* narrowedSuspended(value) {
	const input = value >>> 0;
	return Boolean(input, yield 1);
}
for (const value of [0, -0, NaN, Infinity, -1, 1, 2 ** 32 - 1, "", "0", "x"]) {
	check(objectBoolean(value) === true, "known object is truthy");
	check(positiveBoolean(value) === true, "positive range is truthy");
	check(unsignedBoolean(value) === !!(value >>> 0), "unsigned range excludes NaN");
	check(stringBoolean(value) === !!("" + value), "known String conversion");
	for (const flag of [false, true]) {
		check(
			optionalBoolean(value, flag) === (flag && !!+value),
			"Number or undefined union",
		);
		check(
			numberBoolean(value, flag) === (flag ? !!+value : !!value),
			"Number or Boolean union",
		);
		check(
			stringBigintBoolean(value, flag) === (flag && !!("" + value)),
			"String or BigInt union",
		);
	}
}
for (const [invoke, input, expected, validate] of [
	[objectBoolean, poison, true, (value) => value.value === poison],
	[positiveBoolean, -1, true, (value) => value === 2 ** 32],
	[unsignedBoolean, 0, false, (value) => value === 0],
	[stringBoolean, "", false, (value) => value === ""],
	[
		(value, extra) => optionalBoolean(value, true, extra),
		NaN,
		false,
		(value) => NativeBoolean(value) === false,
	],
]) {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Boolean");
	try {
		check(
			invoke(input, () => {
				globalThis.Boolean = () => marker;
				if (typeof gc === "function") gc();
			}) === expected,
			"narrowed call keeps the captured builtin",
		);
		globalThis.Boolean = function (value) {
			check(
				this === undefined && arguments.length === 2 && validate(value),
				"narrowed fallback ABI",
			);
			return marker;
		};
		check(invoke(input) === marker, "narrowed call keeps arbitrary fallback result");
		globalThis.Boolean = new Proxy(NativeBoolean, {
			apply() {
				return marker;
			},
		});
		check(invoke(input) === marker, "narrowed call does not bypass a proxy");
	} finally {
		Object.defineProperty(globalThis, "Boolean", descriptor);
	}
}
for (const value of [0, 1]) {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Boolean");
	try {
		const iterator = narrowedSuspended(value);
		check(iterator.next().value === 1, "narrowed suspension point");
		globalThis.Boolean = () => marker;
		if (typeof gc === "function") gc();
		check(
			iterator.next().value === !!value,
			"narrowed suspension keeps captured callee and scalar value",
		);
	} finally {
		Object.defineProperty(globalThis, "Boolean", descriptor);
	}
}

const conversionEvents = [];
try {
	Object.defineProperty(globalThis, "Boolean", {
		configurable: true,
		get() {
			conversionEvents.push("get");
			return NativeBoolean;
		},
	});
	check(
		positiveBoolean(
			{
				valueOf() {
					conversionEvents.push("coerce");
					return 0;
				},
			},
			() => conversionEvents.push("argument"),
		) === true,
		"constant truthiness keeps coercion",
	);
	check(
		conversionEvents.join() === "coerce,get,argument",
		"producer remains before callee lookup",
	);
	const failure = {};
	let caught;
	try {
		positiveBoolean({
			valueOf() {
				throw failure;
			},
		});
	} catch (error) {
		caught = error;
	}
	check(caught === failure, "constant truthiness keeps producer throw");
} finally {
	Object.defineProperty(globalThis, "Boolean", globalDescriptor);
}
console.log("boolean guards passed");
