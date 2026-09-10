function check(value, message) {
	if (!value) throw new Error(message);
}
function ignored(value, effect) {
	!value;
	Boolean(value);
	new Boolean(value);
	Boolean.prototype.valueOf.call(!!value);
	effect();
	return 17;
}
function ignoredInputs(first, second) {
	Boolean(first());
	new Boolean(second());
	return 19;
}
function reused(value, effect) {
	const first = Boolean(value);
	const type = typeof value;
	const negated = !value;
	effect(value);
	return [first, Boolean(value), type, typeof value, negated, !value];
}
function coercing(value, effect) {
	const first = -value;
	effect();
	return [first, -value];
}
function* suspended(value, effect) {
	Boolean(value);
	yield effect();
	new Boolean(value);
	return !value;
}
function ignoredTdz(value) {
	!later;
	let later = value;
}
globalThis.booleanProfiles = {
	ignored,
	ignoredInputs,
	reused,
	coercing,
	suspended,
	ignoredTdz,
};
const sentinel = {};
const hostile = {
	[Symbol.toPrimitive]() {
		throw sentinel;
	},
	valueOf() {
		throw sentinel;
	},
	toString() {
		throw sentinel;
	},
};
const revoked = Proxy.revocable(function () {}, {});
revoked.revoke();
let calls = 0;
for (const value of [
	undefined,
	null,
	false,
	true,
	0,
	-0,
	NaN,
	Infinity,
	"",
	"text",
	0n,
	17n,
	Symbol(),
	hostile,
	new Boolean(false),
	revoked.proxy,
]) {
	check(
		globalThis.booleanProfiles.ignored(value, () => calls++) === 17,
		"ignored truthiness preserves its following callback",
	);
	const values = globalThis.booleanProfiles.reused(value, () => {
		calls++;
		if (typeof globalThis.gc === "function") globalThis.gc();
	});
	check(
		values[0] === values[1] && values[0] === Boolean(value),
		"reused Boolean result is stable across callbacks",
	);
	check(
		values[2] === values[3] && values[2] === typeof value,
		"reused type survives callback and revocation",
	);
	check(
		values[4] === values[5] && values[4] === !value,
		"reused logical negation preserves the result",
	);
	const iterator = globalThis.booleanProfiles.suspended(value, () => calls++);
	check(iterator.next().done === false, "ignored truthiness does not remove a yield");
	const last = iterator.next();
	check(last.done && last.value === !value, "demanded truthiness survives suspension");
}
check(calls === 48, "callbacks are evaluated once per source occurrence");
const events = [];
check(
	globalThis.booleanProfiles.ignoredInputs(
		() => {
			events.push("first");
			return hostile;
		},
		() => {
			events.push("second");
			return hostile;
		},
	) === 19,
	"truthiness does not coerce objects",
);
check(events.join(",") === "first,second", "ignored Boolean arguments retain order");
try {
	globalThis.booleanProfiles.ignoredInputs(
		() => {
			throw sentinel;
		},
		() => {
			throw new Error("unreachable second argument");
		},
	);
	throw new Error("argument error must propagate");
} catch (error) {
	check(error === sentinel, "argument error identity is retained");
}
let payload = 3;
let conversions = 0;
const numeric = {
	[Symbol.toPrimitive]() {
		conversions++;
		return payload;
	},
};
const numbers = globalThis.booleanProfiles.coercing(numeric, () => {
	payload = 7;
});
check(
	numbers[0] === -3 && numbers[1] === -7 && conversions === 2,
	"numeric coercion is repeated after mutation",
);
try {
	globalThis.booleanProfiles.ignoredTdz(1);
	throw new Error("TDZ must throw");
} catch (error) {
	check(
		error instanceof ReferenceError,
		"dead truthiness retains an earlier TDZ failure",
	);
}
const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Boolean");
if (descriptor.configurable) {
	let invocations = 0;
	try {
		Object.defineProperty(globalThis, "Boolean", {
			...descriptor,
			value() {
				return ++invocations;
			},
		});
		const result = globalThis.booleanProfiles.reused(1, () => {});
		check(
			result[0] === 1 && result[1] === 2 && invocations === 2,
			"mutable Boolean replacement is called twice",
		);
	} finally {
		Object.defineProperty(globalThis, "Boolean", descriptor);
	}
}
console.log("Boolean result profiles passed");
