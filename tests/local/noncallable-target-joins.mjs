let argumentCalls = 0;
let targetCalls = 0;

function check(condition, message) {
	if (!condition) throw new Error(message);
}

function argument() {
	argumentCalls++;
	return "payload";
}

function invoked(value) {
	targetCalls++;
	return value;
}

function undefinedChoice(flag) {
	const target = flag ? (value) => invoked(value) : undefined;
	return target(argument());
}

function nullChoice(flag) {
	const target = flag ? (value) => invoked(value) : null;
	return target(argument());
}

function numberChoice(flag) {
	const target = flag ? (value) => invoked(value) : 0;
	return target(argument());
}

function booleanChoice(flag) {
	const target = flag ? (value) => invoked(value) : false;
	return target(argument());
}

function stringChoice(flag) {
	const target = flag ? (value) => invoked(value) : "not callable";
	return target(argument());
}

function bigintChoice(flag) {
	const target = flag ? (value) => invoked(value) : 1n;
	return target(argument());
}

function arrayChoice(flag) {
	const target = flag ? (value) => invoked(value) : [];
	return target(argument());
}

function objectChoice(flag) {
	const target = flag
		? (value) => invoked(value)
		: {
				valueOf() {
					throw new Error("callability must not coerce objects");
				},
			};
	return target(argument());
}

function capturedChoice(flag) {
	let target;
	if (flag) target = (value) => invoked(value);
	return (() => target(argument()))();
}

for (const choose of [
	undefinedChoice,
	nullChoice,
	numberChoice,
	booleanChoice,
	stringChoice,
	bigintChoice,
	arrayChoice,
	objectChoice,
	capturedChoice,
]) {
	const argumentsBefore = argumentCalls;
	const targetsBefore = targetCalls;
	let thrown;
	try {
		choose(false);
	} catch (error) {
		thrown = error;
	}
	check(
		thrown instanceof TypeError,
		choose.name + " rejects its non-callable alternative",
	);
	check(
		argumentCalls === argumentsBefore + 1,
		"arguments run before the callability error",
	);
	check(
		targetCalls === targetsBefore,
		"a rejected call must not enter the known function",
	);
	check(choose(true) === "payload", "the callable alternative keeps its result");
	check(
		argumentCalls === argumentsBefore + 2 && targetCalls === targetsBefore + 1,
		"guarded calls evaluate arguments and enter the target exactly once",
	);
}

const direct = globalThis.noncallableFixtureToggle ? () => 1 : undefined;
let directError;
try {
	direct();
} catch (error) {
	directError = error;
}
check(
	directError instanceof TypeError,
	"module const joins retain non-callable alternatives",
);

const argumentError = {};
function throwingArgument() {
	throw argumentError;
}
let argumentFailure;
try {
	direct(throwingArgument());
} catch (error) {
	argumentFailure = error;
}
check(
	argumentFailure === argumentError,
	"an abrupt argument takes precedence over callability",
);

function beforeInitialization() {
	let caught;
	try {
		later();
	} catch (error) {
		caught = error;
	}
	const later = () => 1;
	check(caught instanceof ReferenceError, "a known function cannot bypass the TDZ guard");
	check(later() === 1, "the initialized binding still calls its known function");
}
beforeInitialization();
console.log("noncallable-target-joins PASS");
