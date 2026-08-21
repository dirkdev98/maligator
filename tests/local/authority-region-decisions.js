const results = [];

function check(name, condition) {
	results.push([name, !!condition]);
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

check("split projection", splitProjection("left;right") === "right:left:2");
check("split cursor", splitCursor(" a ; bb ", ";") === 3);
check("slice Number", sliceNumber("x42") === 42);
check("fresh RegExp projection", regexpSummary("ABC:def") === 68);

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
