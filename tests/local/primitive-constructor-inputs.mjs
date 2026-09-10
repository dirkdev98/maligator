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
console.log("primitive constructor inputs passed");
