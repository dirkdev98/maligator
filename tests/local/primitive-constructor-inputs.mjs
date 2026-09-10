function check(value, message) {
	if (!value) throw new Error(message);
}
globalThis.constructorInputs = {
	empty(effect) {
		return new Boolean({}, effect());
	},
	computed(key, value) {
		return new Boolean({ [key]: value() });
	},
	unknown(value) {
		return new Boolean(value);
	},
	numbers(effect) {
		return [
			new Number("-0", effect()),
			new Number("invalid"),
			new Number(17n),
			new Number(null),
		];
	},
	strings(effect) {
		return [new String(-0, effect()), new String(17n), new String(null), new String(NaN)];
	},
	convertNumber(value, target) {
		return Reflect.construct(Number, [value], target);
	},
	convertString(value, target) {
		return Reflect.construct(String, [value], target);
	},
	reflected(target, effect) {
		return Reflect.construct(Boolean, [{}, effect()], target);
	},
	*suspended(effect) {
		return new Boolean({}, yield effect());
	},
};
const operations = globalThis.constructorInputs;
const sentinel = {};
const hostile = {
	[Symbol.toPrimitive]() {
		throw sentinel;
	},
};
const revoked = Proxy.revocable({}, {});
revoked.revoke();
for (const value of [
	false,
	0,
	-0,
	NaN,
	"",
	0n,
	null,
	undefined,
	true,
	"text",
	7n,
	Symbol(),
	hostile,
	revoked.proxy,
]) {
	const wrapper = operations.unknown(value);
	check(wrapper.valueOf() === !!value, "unknown input retains ToBoolean semantics");
}
const events = [];
const numberBoxes = operations.numbers(() => events.push("number argument"));
const stringBoxes = operations.strings(() => events.push("string argument"));
check(
	Object.is(numberBoxes[0].valueOf(), -0) &&
		Number.isNaN(numberBoxes[1].valueOf()) &&
		numberBoxes[2].valueOf() === 17 &&
		numberBoxes[3].valueOf() === 0,
	"constant Number inputs retain payloads",
);
check(
	stringBoxes.map((value) => value.valueOf()).join(",") === "0,17,null,NaN",
	"constant String inputs retain payloads",
);
check(
	events.join(",") === "number argument,string argument",
	"preconverted inputs preserve extra arguments",
);
check(
	numberBoxes[0] !== operations.numbers(() => {})[0] &&
		stringBoxes[0] !== operations.strings(() => {})[0],
	"Number and String wrappers remain fresh",
);
events.length = 0;
const first = operations.empty(() => events.push("argument"));
const second = operations.empty(() => events.push("argument"));
check(
	first !== second && first.valueOf() && second.valueOf(),
	"escaping wrappers remain fresh",
);
check(Object.getPrototypeOf(first) === Boolean.prototype, "default wrapper prototype");
const computed = operations.computed(
	{
		[Symbol.toPrimitive](hint) {
			events.push(hint);
			return "value";
		},
	},
	() => events.push("value"),
);
check(
	computed.valueOf() && events.join(",") === "argument,argument,string,value",
	"input producers retain order",
);
const prototype = {};
const target = new Proxy(function () {}, {
	get(_target, key) {
		if (key === "prototype") {
			events.push("prototype");
			if (typeof globalThis.gc === "function") globalThis.gc();
			return prototype;
		}
		throw new Error("unexpected newTarget lookup");
	},
});
events.length = 0;
const reflected = operations.reflected(target, () => events.push("argument"));
check(
	Object.getPrototypeOf(reflected) === prototype &&
		Boolean.prototype.valueOf.call(reflected),
	"newTarget prototype and Boolean payload survive",
);
check(
	events.join(",") === "argument,prototype",
	"arguments precede newTarget prototype lookup",
);
for (const [name, expected, method] of [
	["convertNumber", 23, Number.prototype.valueOf],
	["convertString", "23", String.prototype.valueOf],
]) {
	events.length = 0;
	const box = operations[name](
		{
			[Symbol.toPrimitive](hint) {
				events.push(hint);
				return 23;
			},
		},
		target,
	);
	check(
		method.call(box) === expected && Object.getPrototypeOf(box) === prototype,
		"effectful conversion retains wrapper payload and prototype",
	);
	check(
		events.join(",") ===
			(name === "convertNumber" ? "number,prototype" : "string,prototype"),
		"input conversion precedes prototype lookup",
	);
	try {
		operations[name](hostile, target);
		throw new Error("conversion must throw");
	} catch (error) {
		check(error === sentinel, "input coercion exception retains identity");
	}
	try {
		operations[name](Symbol.iterator, target);
		throw new Error("Symbol constructor input must throw");
	} catch (error) {
		check(error instanceof TypeError, "constructor rejects Symbol input");
	}
}
try {
	operations.reflected(
		new Proxy(function () {}, {
			get() {
				throw sentinel;
			},
		}),
		() => {},
	);
	throw new Error("prototype lookup must throw");
} catch (error) {
	check(error === sentinel, "prototype exception retains identity");
}
const iterator = operations.suspended(() => 17);
check(iterator.next().value === 17, "constructor arguments preserve suspension");
const originalBoolean = Boolean;
if (Object.getOwnPropertyDescriptor(globalThis, "Boolean").writable) {
	let input;
	try {
		globalThis.Boolean = function (value) {
			input = value;
			return sentinel;
		};
		check(
			iterator.next().value.valueOf() === true,
			"constructor is captured before suspension",
		);
		check(
			operations.empty(() => {}) === sentinel && typeof input === "object",
			"replacement receives original object input",
		);
	} finally {
		globalThis.Boolean = originalBoolean;
	}
} else {
	check(iterator.next().value.valueOf() === true, "locked constructor resumes correctly");
}
for (const [constructor, operation, expected] of [
	["Number", "numbers", "-0"],
	["String", "strings", -0],
]) {
	const original = globalThis[constructor];
	if (!Object.getOwnPropertyDescriptor(globalThis, constructor).writable) continue;
	const received = [];
	try {
		globalThis[constructor] = function (value) {
			received.push(value);
			return sentinel;
		};
		const result = operations[operation](() => {});
		check(
			result.every((value) => value === sentinel) && Object.is(received[0], expected),
			"mutable constructors receive unconverted inputs",
		);
	} finally {
		globalThis[constructor] = original;
	}
}
console.log("primitive constructor inputs passed");
