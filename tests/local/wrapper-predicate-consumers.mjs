function check(condition, message) {
	if (!condition) throw new Error(message);
}
function throwsTypeError(run) {
	let caught;
	try {
		run();
	} catch (error) {
		caught = error;
	}
	check(caught instanceof TypeError, "constructor conversion must throw TypeError");
}
function numberFinite(value) {
	return Number.isFinite(new Number(value));
}
function numberNan(value) {
	return Number.isNaN(new Number(value));
}
function numberInteger(value) {
	return Number.isInteger(new Number(value));
}
function numberSafe(value) {
	return Number.isSafeInteger(new Number(value));
}
function stringFinite(value) {
	return Number.isFinite(new String(value));
}
function stringNan(value) {
	return Number.isNaN(new String(value));
}
function stringInteger(value) {
	return Number.isInteger(new String(value));
}
function stringSafe(value) {
	return Number.isSafeInteger(new String(value));
}
function booleanFinite(value) {
	return Number.isFinite(new Boolean(value));
}
function booleanNan(value) {
	return Number.isNaN(new Boolean(value));
}
function booleanInteger(value) {
	return Number.isInteger(new Boolean(value));
}
function booleanSafe(value) {
	return Number.isSafeInteger(new Boolean(value));
}
function boxedBigint() {
	return Number.isSafeInteger(Object(1n));
}
function boxedSymbol() {
	return Number.isNaN(Object(Symbol.iterator));
}
function describedSymbol(value) {
	return Number.isFinite(Object(Symbol(value)));
}
const values = [
	undefined,
	null,
	false,
	true,
	0,
	-0,
	NaN,
	Infinity,
	-Infinity,
	1.5,
	3n,
	"42",
	"bad",
];
const converting = [
	numberFinite,
	numberNan,
	numberInteger,
	numberSafe,
	stringFinite,
	stringNan,
	stringInteger,
	stringSafe,
];
for (const predicate of [
	...converting,
	booleanFinite,
	booleanNan,
	booleanInteger,
	booleanSafe,
]) {
	for (const value of values)
		check(predicate(value) === false, "wrapper is never a Number primitive");
}
for (const predicate of converting) throwsTypeError(() => predicate(Symbol.iterator));
check(
	booleanFinite(Symbol.iterator) === false &&
		boxedBigint() === false &&
		boxedSymbol() === false,
	"noncoercing wrapper brands",
);

function numberWithExtra(value, extra) {
	return Number.isFinite(new Number(value), extra());
}
function stringWithExtra(value, extra) {
	return Number.isInteger(new String(value), extra());
}
function booleanWithExtra(value, extra) {
	return Number.isSafeInteger(new Boolean(value), extra());
}
const events = [];
const numeric = {
	[Symbol.toPrimitive](hint) {
		events.push(hint);
		return 3n;
	},
};
const text = {
	[Symbol.toPrimitive](hint) {
		events.push(hint);
		return 2n;
	},
};
const extra = () => {
	events.push("extra");
	return 99;
};
check(numberWithExtra(numeric, extra) === false, "Number object-to-BigInt conversion");
check(events.join(",") === "number,extra", "Number conversion before later arguments");
events.length = 0;
check(stringWithExtra(text, extra) === false, "String object-to-BigInt conversion");
check(events.join(",") === "string,extra", "String conversion before later arguments");
events.length = 0;
const marker = {};
const poison = {
	[Symbol.toPrimitive]() {
		throw marker;
	},
};
check(
	booleanWithExtra(poison, extra) === false && events.join(",") === "extra",
	"Boolean must not coerce its payload",
);
for (const predicate of [numberWithExtra, stringWithExtra]) {
	events.length = 0;
	let caught;
	try {
		predicate(poison, extra);
	} catch (error) {
		caught = error;
	}
	check(
		caught === marker && events.length === 0,
		"conversion exception precedes later arguments",
	);
	throwsTypeError(() => predicate(Symbol.iterator, extra));
	check(events.length === 0, "Symbol conversion precedes later arguments");
}
events.length = 0;
check(
	describedSymbol(text) === false && events.join(",") === "string",
	"discarded Symbol wrapper preserves description conversion",
);

function sameNumber(value) {
	const wrapper = new Number(value);
	return wrapper === wrapper;
}
function differentNumber(value) {
	const wrapper = new Number(value);
	return wrapper !== wrapper;
}
for (const value of values)
	check(
		sameNumber(value) === true && differentNumber(value) === false,
		"wrapper identity is independent of NaN payload",
	);
throwsTypeError(() => sameNumber(Symbol.iterator));
throwsTypeError(() => differentNumber(Symbol.iterator));
events.length = 0;
check(
	new Number(numeric) !== new Number(numeric) && events.join(",") === "number,number",
	"distinct wrappers preserve both conversions",
);
function mixedNumber(value) {
	const wrapper = new Number(value);
	return [Number.isFinite(wrapper), wrapper.valueOf(), wrapper === wrapper];
}
const mixed = mixedNumber(-0);
check(
	mixed[0] === false && Object.is(mixed[1], -0) && mixed[2] === true,
	"mixed consumers preserve payload and identity results",
);
function mixedBoolean(value) {
	const wrapper = new Boolean(value);
	return [Number.isNaN(wrapper), !wrapper, wrapper.valueOf()];
}
check(
	mixedBoolean(false).every((value) => value === false),
	"false payload still has object truthiness",
);
function mixedString(value) {
	const wrapper = new String(value);
	return [Number.isInteger(wrapper), wrapper.length, wrapper[1]];
}
const parts = mixedString("abc");
check(
	parts[0] === false && parts[1] === 3 && parts[2] === "b",
	"String projections compose with a predicate",
);

let leaked;
function escaping(value) {
	const wrapper = new Number(value);
	leaked = wrapper;
	return Number.isInteger(wrapper);
}
check(
	escaping(7) === false && typeof leaked === "object" && leaked.valueOf() === 7,
	"escaping consumer retains a Number object",
);
const previous = leaked;
escaping(7);
check(previous !== leaked, "escaping wrapper identities remain fresh");
function ignoredReceiver(value) {
	return Number.isFinite.call(new Number(value), 1);
}
function ignoredArgument(value) {
	return Number.isInteger(1, new String(value));
}
check(
	ignoredReceiver(4) === true && ignoredArgument("x") === true,
	"receiver and extra predicate arguments are ignored",
);
throwsTypeError(() => ignoredReceiver(Symbol.iterator));
throwsTypeError(() => ignoredArgument(Symbol.iterator));

function Alternate() {}
const newTarget = new Proxy(Alternate, {
	get(target, key, receiver) {
		if (key === "prototype") events.push("prototype");
		return Reflect.get(target, key, receiver);
	},
});
events.length = 0;
check(
	Number.isFinite(Reflect.construct(Number, [numeric], newTarget)) === false,
	"custom newTarget remains a wrapper",
);
check(
	events.join(",") === "number,prototype",
	"conversion and newTarget prototype access keep their order",
);
class Derived extends Number {}
const derived = new Derived(5);
check(
	Number.isNaN(derived) === false &&
		derived instanceof Derived &&
		derived.valueOf() === 5,
	"subclass prototype and payload survive",
);

if (!Object.isFrozen(Number)) {
	const descriptor = Object.getOwnPropertyDescriptor(Number, "isFinite");
	let observed;
	try {
		Number.isFinite = function (value) {
			observed = value;
			return "fallback";
		};
		check(
			numberFinite(6) === "fallback" &&
				observed instanceof Number &&
				observed.valueOf() === 6,
			"replacement predicate observes the actual wrapper",
		);
	} finally {
		Object.defineProperty(Number, "isFinite", descriptor);
	}
	try {
		const changesMethod = {
			valueOf() {
				Number.isFinite = () => "changed";
				return 4;
			},
		};
		check(
			numberFinite(changesMethod) === false,
			"callee is captured before constructor conversion",
		);
		check(numberFinite(4) === "changed", "later calls see predicate replacement");
	} finally {
		Object.defineProperty(Number, "isFinite", descriptor);
	}
}
console.log("wrapper predicate consumers passed");
