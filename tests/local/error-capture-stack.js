let passed = 0;
let total = 0;

function check(name, condition) {
	total++;
	if (condition) {
		passed++;
	} else {
		console.log("FAIL: " + name);
	}
}

const captureDescriptor = Object.getOwnPropertyDescriptor(Error, "captureStackTrace");
check(
	"captureStackTrace descriptor and arity",
	typeof captureDescriptor.value === "function" &&
		captureDescriptor.value.length === 2 &&
		captureDescriptor.writable === true &&
		captureDescriptor.enumerable === false &&
		captureDescriptor.configurable === true,
);

const limitDescriptor = Object.getOwnPropertyDescriptor(Error, "stackTraceLimit");
check(
	"stackTraceLimit default descriptor",
	Error.stackTraceLimit === 10 &&
		limitDescriptor.writable === true &&
		limitDescriptor.enumerable === true &&
		limitDescriptor.configurable === true,
);

const builtinErrors = [
	new Error("error"),
	new TypeError("type"),
	new RangeError("range"),
	new ReferenceError("reference"),
	new SyntaxError("syntax"),
	new URIError("uri"),
	new EvalError("eval"),
	new AggregateError([], "aggregate"),
];
check(
	"ErrorData recognizes every built-in error kind",
	builtinErrors.every((error) => Error.isError(error)),
);
check(
	"ErrorData is an internal slot rather than inherited state",
	!Error.isError(Object.create(Error.prototype)) &&
		!Error.isError({ name: "Error", message: "lookalike" }) &&
		!Error.isError(undefined),
);
check(
	"ErrorData still drives Object.prototype.toString",
	Object.prototype.toString.call(new Error()) === "[object Error]",
);
const longName = "N".repeat(100);
const longMessage = "M".repeat(100);
check(
	"Error toString preserves inline and spill concatenation",
	new TypeError("native machinery").toString() === "TypeError: native machinery" &&
		Error.prototype.toString.call({ name: longName, message: longMessage }) ===
			longName + ": " + longMessage,
);
const errorStringOrder = [];
const rootedErrorName = "Rooted".repeat(64);
const rootedErrorString = Error.prototype.toString.call({
	get name() {
		errorStringOrder.push("name");
		return rootedErrorName;
	},
	get message() {
		errorStringOrder.push("message");
		if (typeof __mal_collect_garbage === "function") __mal_collect_garbage();
		return "message";
	},
});
check(
	"Error toString roots observable string parts",
	rootedErrorString === rootedErrorName + ": message" &&
		errorStringOrder.join(",") === "name,message",
);

let preparedTarget;
let preparedSites;
Error.prepareStackTrace = function prepare(target, sites) {
	preparedTarget = target;
	preparedSites = sites;
	return sites;
};

function captureBoundary() {
	const target = { name: "Probe", message: "value" };
	Error.captureStackTrace(target, captureBoundary);
	return target;
}

function captureCaller() {
	return captureBoundary();
}

const target = captureCaller();
const stackDescriptor = Object.getOwnPropertyDescriptor(target, "stack");
check(
	"plain target receives own configurable accessor",
	typeof stackDescriptor.get === "function" &&
		typeof stackDescriptor.set === "function" &&
		stackDescriptor.enumerable === false &&
		stackDescriptor.configurable === true,
);

const sites = target.stack;
const first = sites[0];
check(
	"prepareStackTrace target and array",
	preparedTarget === target && preparedSites === sites,
);
check(
	"constructorOpt filters through script boundary",
	first.getFunctionName() === "captureCaller",
);
check(
	"minimal CallSite metadata",
	typeof first.getFileName() === "string" &&
		first.getFileName().indexOf("error-capture-stack.js") !== -1 &&
		typeof first.getLineNumber() === "number" &&
		typeof first.getColumnNumber() === "number" &&
		first.isEval() === false &&
		first.getThis() === undefined,
);
check(
	"CallSite toString",
	first.toString().indexOf("captureCaller (") === 0 &&
		first.toString().indexOf("error-capture-stack.js:") !== -1,
);

Error.stackTraceLimit = 2;
Error.prepareStackTrace = function limitPrepare(_target, callsites) {
	return callsites.length;
};
function limitInner() {
	const value = {};
	Error.captureStackTrace(value);
	return value.stack;
}
function limitOuter() {
	return limitInner();
}
check("stackTraceLimit", limitOuter() === 2);

Error.stackTraceLimit = "not a number";
const unavailable = {};
Error.captureStackTrace(unavailable);
check(
	"non-number stackTraceLimit makes stack unavailable",
	unavailable.stack === undefined,
);

Error.stackTraceLimit = 10;
const abrupt = { marker: "prepare" };
Error.prepareStackTrace = function abruptPrepare() {
	throw abrupt;
};
const abruptTarget = {};
Error.captureStackTrace(abruptTarget);
let caught;
try {
	abruptTarget.stack;
} catch (error) {
	caught = error;
}
check("prepareStackTrace abrupt completion", caught === abrupt);

const savedLimit = Object.getOwnPropertyDescriptor(Error, "stackTraceLimit");
const limitAbrupt = { marker: "limit" };
Object.defineProperty(Error, "stackTraceLimit", {
	configurable: true,
	get: function getLimit() {
		throw limitAbrupt;
	},
});
caught = undefined;
try {
	Error.captureStackTrace({});
} catch (error) {
	caught = error;
}
Object.defineProperty(Error, "stackTraceLimit", savedLimit);
check("stackTraceLimit getter abrupt completion", caught === limitAbrupt);

Error.prepareStackTrace = undefined;
function defaultBoundary() {
	const value = { name: "Probe", message: "value" };
	Error.captureStackTrace(value, defaultBoundary);
	return value;
}
function defaultCaller() {
	return defaultBoundary();
}
const defaultStack = defaultCaller().stack;
check(
	"captured default string",
	typeof defaultStack === "string" &&
		defaultStack.indexOf("Probe: value\n    at defaultCaller (") === 0,
);
const ordinaryStack = new Error("boom").stack;
check(
	"ordinary Error stack string remains intact",
	typeof ordinaryStack === "string" &&
		ordinaryStack.indexOf("Error: boom\n    at ") === 0,
);

const anonymousFunction = (0, function () {});
check("anonymous Function name", anonymousFunction.name === "");

const anonymousStack = (function () {
	return new Error("anonymous").stack;
})();
check(
	"anonymous default stack frame",
	typeof anonymousStack === "string" &&
		anonymousStack.indexOf("Error: anonymous\n    at <anonymous> (") === 0,
);

Error.prepareStackTrace = function anonymousPrepare(_target, callsites) {
	return callsites[0].getFunctionName();
};
function anonymousCallSiteBoundary() {
	const value = {};
	Error.captureStackTrace(value, anonymousCallSiteBoundary);
	return value.stack;
}
const anonymousCallSiteName = (0,
function () {
	return anonymousCallSiteBoundary();
})();
check("anonymous CallSite function name", anonymousCallSiteName === null);
Error.prepareStackTrace = undefined;

caught = undefined;
try {
	Error.captureStackTrace(1);
} catch (error) {
	caught = error;
}
check("primitive target rejected", caught instanceof TypeError);

const fixed = {};
Object.defineProperty(fixed, "stack", { value: "fixed" });
caught = undefined;
try {
	Error.captureStackTrace(fixed);
} catch (error) {
	caught = error;
}
check(
	"non-configurable stack rejected",
	caught instanceof TypeError && fixed.stack === "fixed",
);

const nonExtensible = Object.preventExtensions({});
const nonExtensibleWithStack = {};
Object.defineProperty(nonExtensibleWithStack, "stack", {
	configurable: true,
	value: "unchanged",
});
Object.preventExtensions(nonExtensibleWithStack);
let freshCaught;
let existingCaught;
try {
	Error.captureStackTrace(nonExtensible);
} catch (error) {
	freshCaught = error;
}
try {
	Error.captureStackTrace(nonExtensibleWithStack);
} catch (error) {
	existingCaught = error;
}
check(
	"non-extensible target install is atomic",
	freshCaught instanceof TypeError &&
		!Object.prototype.hasOwnProperty.call(nonExtensible, "stack") &&
		existingCaught instanceof TypeError &&
		nonExtensibleWithStack.stack === "unchanged",
);

Error.prepareStackTrace = function allocatingPrepare(_target, callsites) {
	const values = [];
	for (let i = 0; i < 200; i++) values.push({ i: i, text: "value-" + i });
	return callsites[0].getFileName() + ":" + values[199].i;
};
const rooted = {};
Error.captureStackTrace(rooted);
check(
	"prepare callback values remain rooted",
	rooted.stack.indexOf("error-capture-stack.js:199") !== -1,
);

Error.prepareStackTrace = undefined;
Error.stackTraceLimit = 3;
let churnTarget = {};
for (let i = 0; i < 512; i++) {
	// Replacing a capture on the same object must retire the old native trace;
	// periodically dropping the object exercises finalizer-driven retirement.
	Error.captureStackTrace(churnTarget);
	if (i % 3 === 0) Error.captureStackTrace(churnTarget);
	if (i % 8 === 0) churnTarget = {};
	if (i % 16 === 0 && typeof __mal_collect_garbage === "function") {
		__mal_collect_garbage();
	}
}
const churnStack = churnTarget.stack;
check(
	"capture churn keeps the current trace valid",
	typeof churnStack === "string" && churnStack.indexOf("error-capture-stack.js:") !== -1,
);

console.log("RESULT " + passed + "/" + total);
