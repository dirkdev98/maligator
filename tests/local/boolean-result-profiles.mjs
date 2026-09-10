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
function constantComparisons(value, effect) {
	const first = Boolean(value);
	effect();
	return [
		first === Boolean(value),
		first !== Boolean(value),
		first == Boolean(value),
		first != Boolean(value),
	];
}
function literalTruthiness(first, second) {
	return Boolean({ first: first(), second: second() }) && Boolean([first(), second()]);
}
function escapedTruthiness(value, observe) {
	const record = { value };
	observe(record);
	return Boolean(record);
}
function textSelf(value, effect) {
	const text = String(value);
	effect();
	return text === text;
}
function numberSelf(value, effect) {
	const number = +value;
	effect();
	return number === number;
}
function* suspendedComparison(value, effect) {
	const boolean = Boolean(value);
	yield effect();
	return boolean === boolean;
}
function methodData(value) {
	return [(!!value).valueOf, (!!value).toString];
}
function methodCalls(value, effect) {
	return [
		(!!value).valueOf(effect()),
		(!!value).toString(effect()),
		Boolean.prototype.valueOf.call(false, effect()),
		Boolean.prototype.toString.call(false, effect()),
	];
}
globalThis.booleanProfiles = {
	ignored,
	ignoredInputs,
	reused,
	coercing,
	suspended,
	ignoredTdz,
	constantComparisons,
	literalTruthiness,
	escapedTruthiness,
	textSelf,
	numberSelf,
	suspendedComparison,
	methodData,
	methodCalls,
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
	const methods = globalThis.booleanProfiles.methodData(value);
	check(
		methods[0] === Boolean.prototype.valueOf && methods[1] === Boolean.prototype.toString,
		"dynamic Boolean method reads preserve canonical function identity",
	);
	let argumentsEvaluated = 0;
	const methodResults = globalThis.booleanProfiles.methodCalls(value, () => {
		argumentsEvaluated++;
		if (typeof globalThis.gc === "function") globalThis.gc();
		return hostile;
	});
	check(
		methodResults[0] === !!value &&
			methodResults[1] === (value ? "true" : "false") &&
			methodResults[2] === false &&
			methodResults[3] === "false" &&
			argumentsEvaluated === 4,
		"Boolean method specialization preserves ignored argument effects",
	);
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
	const comparisons = globalThis.booleanProfiles.constantComparisons(value, () => {
		if (typeof globalThis.gc === "function") globalThis.gc();
	});
	check(
		comparisons.join(",") === "true,false,true,false",
		"Boolean comparisons exclude NaN without coercing their inputs",
	);
	const suspended = globalThis.booleanProfiles.suspendedComparison(value, () => 23);
	check(suspended.next().value === 23, "constant comparison retains suspension");
	const completed = suspended.next();
	check(
		completed.done && completed.value === true,
		"Boolean identity survives resumption",
	);
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
events.length = 0;
check(
	globalThis.booleanProfiles.literalTruthiness(
		() => {
			events.push("first");
			return hostile;
		},
		() => {
			events.push("second");
			if (typeof globalThis.gc === "function") globalThis.gc();
			return Symbol();
		},
	),
	"private aggregate truthiness does not observe its contents",
);
check(
	events.join(",") === "first,second,first,second",
	"elided aggregates retain producer order",
);
let escaped;
check(
	globalThis.booleanProfiles.escapedTruthiness(hostile, (record) => {
		escaped = record;
		record.extra = 29;
		if (typeof globalThis.gc === "function") globalThis.gc();
	}),
	"observed aggregate remains truthy",
);
check(
	escaped.value === hostile && escaped.extra === 29,
	"escaping aggregate identity is retained",
);
try {
	globalThis.booleanProfiles.literalTruthiness(
		() => {
			throw sentinel;
		},
		() => {
			throw new Error("unreachable aggregate field");
		},
	);
	throw new Error("aggregate input must throw");
} catch (error) {
	check(error === sentinel, "aggregate producer failure precedes folding");
}
let observedText = 0;
check(
	globalThis.booleanProfiles.textSelf(Symbol("value"), () => observedText++),
	"text result is reflexive",
);
check(observedText === 1, "text observation preserves its callback");
try {
	globalThis.booleanProfiles.textSelf(hostile, () => observedText++);
	throw new Error("text input must throw");
} catch (error) {
	check(
		error === sentinel && observedText === 1,
		"folding text equality preserves coercion failure",
	);
}
for (const number of [NaN, 0, -0, Infinity, -Infinity, 7]) {
	check(
		globalThis.booleanProfiles.numberSelf(number, () => {}) === !Number.isNaN(number),
		"number self-comparison preserves NaN",
	);
}
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
const valueOfDescriptor = Object.getOwnPropertyDescriptor(Boolean.prototype, "valueOf");
if (valueOfDescriptor.configurable) {
	const order = [];
	function replacement() {
		order.push("call");
		return 23;
	}
	try {
		Object.defineProperty(Boolean.prototype, "valueOf", {
			configurable: true,
			get() {
				order.push("get");
				return replacement;
			},
		});
		check(
			globalThis.booleanProfiles.methodData(true)[0] === replacement,
			"mutable method read returns the accessor result",
		);
		order.length = 0;
		const results = globalThis.booleanProfiles.methodCalls(true, () => {
			order.push("argument");
			return hostile;
		});
		check(
			results[0] === 23 &&
				results[2] === 23 &&
				order.join(",") === "get,argument,call,argument,get,argument,call,argument",
			"mutable method lookup precedes argument evaluation and call",
		);
	} finally {
		Object.defineProperty(Boolean.prototype, "valueOf", valueOfDescriptor);
	}
}
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
		invocations = 0;
		const comparisons = globalThis.booleanProfiles.constantComparisons(1, () => {});
		check(
			comparisons.join(",") === "false,true,false,true" && invocations === 5,
			"mutable Boolean comparisons retain every original call",
		);
	} finally {
		Object.defineProperty(globalThis, "Boolean", descriptor);
	}
}
console.log("Boolean result profiles passed");
