const results = [];

function check(name, condition) {
	results.push([name, !!condition]);
}

function throwsTypeError(callback) {
	try {
		callback();
		return false;
	} catch (error) {
		return error instanceof TypeError;
	}
}

check(
	"legacy state starts empty",
	RegExp.input === "" && RegExp.lastMatch === "" && RegExp.$1 === "",
);
/(a)(b)(c)?/.exec("prefix-ab-suffix");
check(
	"successful matches update legacy state",
	RegExp.input === "prefix-ab-suffix" &&
		RegExp.lastMatch === "ab" &&
		RegExp.lastParen === "b" &&
		RegExp.leftContext === "prefix-" &&
		RegExp.rightContext === "-suffix" &&
		RegExp.$1 === "a" &&
		RegExp.$2 === "b" &&
		RegExp.$3 === "",
);
/missing/.exec("no match");
check(
	"unsuccessful matches preserve legacy state",
	RegExp.lastMatch === "ab" && RegExp.$1 === "a" && RegExp.$2 === "b",
);
check("RegExp constructor remains frozen", Object.isFrozen(RegExp));
check("RegExp prototype remains frozen", Object.isFrozen(RegExp.prototype));
let inputCoercions = 0;
RegExp.$_ = {
	toString() {
		inputCoercions++;
		return "assigned input";
	},
};
check(
	"legacy input setter remains usable on the frozen constructor",
	RegExp.input === "assigned input" && inputCoercions === 1,
);

function lockedLiteralCharCode(value) {
	const match = /^(?:([A-Z]+))?$/.exec(value);
	if (match === null) return -1;
	return match[1].charCodeAt(0);
}
check("present charCodeAt capture", lockedLiteralCharCode("ABC") === 65);
check(
	"missing charCodeAt capture",
	throwsTypeError(() => lockedLiteralCharCode("")),
);

function lockedLiteralEmptyCharCode(value) {
	const match = /^(.*)$/.exec(value);
	if (match === null) return -1;
	return match[1].charCodeAt(0);
}
check("empty charCodeAt capture", Number.isNaN(lockedLiteralEmptyCharCode("")));

function projectedCharCode(regexp, value) {
	const match = regexp.exec(value);
	if (match === null) return -1;
	return match[1].charCodeAt(0);
}
let customExecCalls = 0;
const customCharCode = {
	exec() {
		customExecCalls++;
		return [
			"match",
			{
				charCodeAt(position) {
					return 40 + position;
				},
			},
		];
	},
};
check(
	"charCodeAt projection-declined fallback",
	projectedCharCode(customCharCode, "ignored") === 40 && customExecCalls === 1,
);

function lockedLiteralCaseLength(value) {
	const match = /^(.*)$/.exec(value);
	if (match === null) return -1;
	return match[1].toUpperCase().toLowerCase().length;
}
check("ASCII case summary", lockedLiteralCaseLength("AbC") === 3);
check("long-capture fallback", lockedLiteralCaseLength("A".repeat(80)) === 80);
check("non-ASCII fallback", lockedLiteralCaseLength("é") === 1);

function projectedCaseLength(regexp, value) {
	const match = regexp.exec(value);
	if (match === null) return -1;
	return match[1].toUpperCase().toLowerCase().length;
}
let upperCalls = 0;
let lowerCalls = 0;
const customCase = {
	exec() {
		return [
			"match",
			{
				toUpperCase() {
					upperCalls++;
					return {
						toLowerCase() {
							lowerCalls++;
							return { length: 73 };
						},
					};
				},
			},
		];
	},
};
check(
	"case projection-declined fallback",
	projectedCaseLength(customCase, "ignored") === 73 &&
		upperCalls === 1 &&
		lowerCalls === 1,
);

let passed = 0;
for (const [name, ok] of results) {
	if (ok) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
