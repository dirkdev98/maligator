const results = [];

function check(name, condition) {
	results.push([name, !!condition]);
}

function forceGc() {
	if (typeof $262 !== "undefined") $262.gc();
	else if (typeof gc === "function") gc();
}

function splitProjection(value) {
	const fields = value.split(";");
	return fields[1] + ":" + fields[0] + ":" + fields.length;
}

function splitCursor(value, separator) {
	const fields = value.split(separator);
	let total = 0;
	for (let index = 0; index < fields.length; index++) {
		total += fields[index].trim().length;
	}
	return total;
}

function sliceNumber(value) {
	return Number(value.slice(1));
}

function regexpSummary(value) {
	const match = /^([A-Z]+):([a-z]+)$/.exec(value);
	if (match === null) return "missing";
	return match[1].charCodeAt(0) + match[2].toUpperCase().toLowerCase().length;
}

let numberPredicateExtraCount = 0;
function numberPredicateExtra() {
	numberPredicateExtraCount++;
	return 17;
}

function numberIsNaN(value) {
	return Number.isNaN(value, numberPredicateExtra());
}

function numberIsFinite(value) {
	return Number.isFinite(value, numberPredicateExtra());
}

function numberIsInteger(value) {
	return Number.isInteger(value, numberPredicateExtra());
}

function numberIsSafeInteger(value) {
	return Number.isSafeInteger(value, numberPredicateExtra());
}

function numberPredicateMask(value) {
	return (
		(numberIsNaN(value) ? 1 : 0) |
		(numberIsFinite(value) ? 2 : 0) |
		(numberIsInteger(value) ? 4 : 0) |
		(numberIsSafeInteger(value) ? 8 : 0)
	);
}

function checkNumberPredicates(name, value, expected) {
	const before = numberPredicateExtraCount;
	check(
		name,
		numberPredicateMask(value) === expected && numberPredicateExtraCount === before + 4,
	);
}

let valueOfExtraCount = 0;
function valueOfExtra() {
	valueOfExtraCount++;
	return 23;
}

function primitiveNumberValueOf() {
	return (42).valueOf(valueOfExtra());
}

function primitiveNegativeZeroValueOf() {
	return (-0).valueOf(valueOfExtra());
}

function primitiveBooleanValueOf() {
	return true.valueOf(valueOfExtra());
}

function primitiveFalseValueOf() {
	return false.valueOf(valueOfExtra());
}

function throwsTypeError(callback) {
	try {
		callback();
	} catch (error) {
		return error instanceof TypeError;
	}
	return false;
}

check("split projection", splitProjection("left;right") === "right:left:2");
check("split cursor", splitCursor(" a ; bb ", ";") === 3);
check("slice Number", sliceNumber("x42") === 42);
check("fresh RegExp projection", regexpSummary("ABC:def") === 68);
checkNumberPredicates("Number predicates NaN", NaN, 1);
checkNumberPredicates("Number predicates finite integer", 42, 14);
checkNumberPredicates("Number predicates finite fraction", 1.5, 2);
checkNumberPredicates("Number predicates Infinity", Infinity, 0);
checkNumberPredicates("Number predicates unsafe integer", Number.MAX_SAFE_INTEGER + 1, 6);
checkNumberPredicates("Number predicates non-number", "42", 0);
const numberLike = {
	isNaN(value) {
		return value === "own";
	},
};
check("own isNaN shadow", numberLike.isNaN("own") === true);
let predicateCoercions = 0;
const predicatePoison = {
	valueOf() {
		predicateCoercions++;
		return 42;
	},
};
checkNumberPredicates("Number predicates do not coerce", predicatePoison, 0);
check("Number predicates skipped coercion", predicateCoercions === 0);
check(
	"Number predicates missing arguments",
	!Number.isNaN() && !Number.isFinite() && !Number.isInteger() && !Number.isSafeInteger(),
);

let valueOfBefore = valueOfExtraCount;
check(
	"primitive Number valueOf",
	primitiveNumberValueOf() === 42 && valueOfExtraCount === valueOfBefore + 1,
);
valueOfBefore = valueOfExtraCount;
check(
	"primitive Number valueOf preserves negative zero",
	Object.is(primitiveNegativeZeroValueOf(), -0) &&
		valueOfExtraCount === valueOfBefore + 1,
);
valueOfBefore = valueOfExtraCount;
check(
	"primitive Boolean valueOf true",
	primitiveBooleanValueOf() === true && valueOfExtraCount === valueOfBefore + 1,
);
valueOfBefore = valueOfExtraCount;
check(
	"primitive Boolean valueOf false",
	primitiveFalseValueOf() === false && valueOfExtraCount === valueOfBefore + 1,
);

check("boxed Number valueOf", Object.is(new Number(-0).valueOf(), -0));
check("boxed Boolean valueOf", new Boolean(false).valueOf() === false);
const shadowedNumber = new Number(5);
shadowedNumber.valueOf = function (marker) {
	return marker === 31 ? 99 : -1;
};
check("boxed Number own valueOf", shadowedNumber.valueOf(31) === 99);
const shadowedBoolean = new Boolean(true);
shadowedBoolean.valueOf = function (marker) {
	return marker === 31 ? "own" : "miss";
};
check("boxed Boolean own valueOf", shadowedBoolean.valueOf(31) === "own");
check(
	"Number valueOf rejects Boolean",
	throwsTypeError(() => Number.prototype.valueOf.call(true)),
);
check(
	"Boolean valueOf rejects Number",
	throwsTypeError(() => Boolean.prototype.valueOf.call(1)),
);

check("parseFloat stack token", parseFloat("  -12.5tail") === -12.5);
check("parseFloat heap token", parseFloat("1" + "0".repeat(80) + "tail") === 1e80);
check(
	"parseFloat heap Infinity token",
	parseFloat("-Infinity" + "x".repeat(80)) === -Infinity,
);
check(
	"parseInt roots ToString result across radix coercion",
	parseInt(
		{
			toString() {
				return String.fromCharCode(49, 50, 51, 52, 53);
			},
		},
		{
			valueOf() {
				forceGc();
				return 10;
			},
		},
	) === 12345,
);

const evalProjection = eval(`(function (value) {
	const fields = value.split(";");
	return fields[1] + ":" + fields[0] + ":" + fields.length;
})`);
const evalCursor = eval(`(function (value) {
	const fields = value.split(";");
	let total = 0;
	for (let index = 0; index < fields.length; index++) {
		total += fields[index].trim().length;
	}
	return total;
})`);
const evalSlice = eval("(function (value) { return Number(value.slice(1)); })");
const evalRegExp = eval(`(function (value) {
	const match = /^([A-Z]+)$/.exec(value);
	return match === null ? -1 : match[1].charCodeAt(0);
})`);
check("eval split projection", evalProjection("left;right") === "right:left:2");
check("eval split cursor", evalCursor(" a ; bb ") === 3);
check("eval slice Number", evalSlice("x42") === 42);
check("eval RegExp projection", evalRegExp("ABC") === 65);

const realmCombined = new ShadowRealm().evaluate(`(function (value) {
	const fields = value.split(";");
	let total = 0;
	for (let index = 0; index < fields.length; index++) {
		total += fields[index].trim().length;
	}
	const match = /^([A-Z]+)$/.exec(fields[0].trim());
	return total * 100 + Number(fields[1].trim().slice(1)) + match[1].charCodeAt(0);
})`);
check("cross-Realm authority regions", realmCombined(" ABC ; x42 ") === 707);
const realmNumberBoolean = new ShadowRealm().evaluate(`(function (value) {
	return Number.isInteger(value) + ":" + (42).valueOf() + ":" + (true).valueOf();
})`);
check("cross-Realm Number and Boolean", realmNumberBoolean(42) === "true:42:true");

function replaceTemporarily(object, name, replacement, callback) {
	const descriptor = Object.getOwnPropertyDescriptor(object, name);
	let installed = false;
	try {
		installed = Reflect.defineProperty(object, name, {
			value: replacement,
			writable: true,
			enumerable: descriptor.enumerable,
			configurable: true,
		});
	} catch (error) {
		if (!(error instanceof TypeError)) throw error;
	}
	if (!installed) return false;
	try {
		callback();
	} finally {
		Reflect.defineProperty(object, name, descriptor);
	}
	return true;
}

for (const [name, call] of [
	["isNaN", numberIsNaN],
	["isFinite", numberIsFinite],
	["isInteger", numberIsInteger],
	["isSafeInteger", numberIsSafeInteger],
]) {
	const before = numberPredicateExtraCount;
	const mutable = replaceTemporarily(
		Number,
		name,
		function (value, marker) {
			return value === "replacement" && marker === 17;
		},
		() => {
			check(
				"mutable Number." + name + " fallback",
				call("replacement") === true && numberPredicateExtraCount === before + 1,
			);
		},
	);
	if (!mutable) {
		check(
			"locked Number." + name + " identity",
			call("replacement") === false && numberPredicateExtraCount === before + 1,
		);
	}
}

valueOfBefore = valueOfExtraCount;
const mutableNumberValueOf = replaceTemporarily(
	Number.prototype,
	"valueOf",
	function (marker) {
		return marker === 23 ? 701 : -1;
	},
	() => {
		check(
			"mutable Number valueOf fallback",
			primitiveNumberValueOf() === 701 && valueOfExtraCount === valueOfBefore + 1,
		);
	},
);
if (!mutableNumberValueOf) {
	check(
		"locked Number valueOf identity",
		primitiveNumberValueOf() === 42 && valueOfExtraCount === valueOfBefore + 1,
	);
}

valueOfBefore = valueOfExtraCount;
const mutableBooleanValueOf = replaceTemporarily(
	Boolean.prototype,
	"valueOf",
	function (marker) {
		return marker === 23 ? "replaced" : "miss";
	},
	() => {
		check(
			"mutable Boolean valueOf fallback",
			primitiveBooleanValueOf() === "replaced" && valueOfExtraCount === valueOfBefore + 1,
		);
	},
);
if (!mutableBooleanValueOf) {
	check(
		"locked Boolean valueOf identity",
		primitiveBooleanValueOf() === true && valueOfExtraCount === valueOfBefore + 1,
	);
}

const mutableSplit = replaceTemporarily(
	String.prototype,
	"split",
	function () {
		return ["custom-left", "custom-right"];
	},
	() => {
		check(
			"mutable split fallback",
			splitProjection("ignored") === "custom-right:custom-left:2",
		);
	},
);
if (!mutableSplit) {
	check("locked split identity", splitProjection("left;right") === "right:left:2");
}

const mutableTrim = replaceTemporarily(
	String.prototype,
	"trim",
	function () {
		return "zzzz";
	},
	() => {
		check("mutable trim fallback", splitCursor("a;bb", ";") === 8);
	},
);
if (!mutableTrim) check("locked trim identity", splitCursor(" a ; bb ", ";") === 3);

const mutableSlice = replaceTemporarily(
	String.prototype,
	"slice",
	function () {
		return "73";
	},
	() => {
		check("mutable slice fallback", sliceNumber("ignored") === 73);
	},
);
if (!mutableSlice) check("locked slice identity", sliceNumber("x42") === 42);

let passed = 0;
for (const [name, ok] of results) {
	if (ok) passed++;
	else console.log("FAIL " + name);
}
console.log("RESULT " + passed + "/" + results.length);
