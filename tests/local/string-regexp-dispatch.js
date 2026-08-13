const results = [];

function check(name, condition) {
	results.push([name, condition]);
}

function throwsTypeError(fn) {
	try {
		fn();
	} catch (error) {
		return error instanceof TypeError;
	}
	return false;
}

const primitiveCases = [
	[BigInt.prototype, 1n, "a1b1c", "1", 1, 3],
	[Boolean.prototype, true, "atruebtruec", "true", 1, 6],
	[Number.prototype, 1, "a1b1c", "1", 1, 3],
	[String.prototype, ",", "a,b,c", ",", 1, 3],
];

for (const [prototype, value, source, text, firstIndex, secondIndex] of primitiveCases) {
	Object.defineProperty(prototype, Symbol.match, {
		configurable: true,
		get() {
			throw new Error("primitive Symbol.match getter called");
		},
	});
	const match = source.match(value);
	check(
		"match skips primitive symbol lookup",
		match[0] === text && match.index === firstIndex && match.input === source,
	);
	delete prototype[Symbol.match];

	Object.defineProperty(prototype, Symbol.matchAll, {
		configurable: true,
		get() {
			throw new Error("primitive Symbol.matchAll getter called");
		},
	});
	const matches = [...source.matchAll(value)];
	check(
		"matchAll skips primitive symbol lookup",
		matches.length === 2 &&
			matches[0][0] === text &&
			matches[0].index === firstIndex &&
			matches[1][0] === text &&
			matches[1].index === secondIndex,
	);
	delete prototype[Symbol.matchAll];

	Object.defineProperty(prototype, Symbol.search, {
		configurable: true,
		get() {
			throw new Error("primitive Symbol.search getter called");
		},
	});
	check("search skips primitive symbol lookup", source.search(value) === firstIndex);
	delete prototype[Symbol.search];
}

for (const [name, method, symbol] of [
	["match", String.prototype.match, Symbol.match],
	["matchAll", String.prototype.matchAll, Symbol.matchAll],
	["search", String.prototype.search, Symbol.search],
]) {
	const expected = {};
	let receivedThis;
	let receivedValue;
	const argument = {};
	argument[symbol] = function (value) {
		receivedThis = this;
		receivedValue = value;
		return expected;
	};
	check(
		name + " dispatches object symbol method",
		method.call("subject", argument) === expected &&
			receivedThis === argument &&
			receivedValue === "subject",
	);
}

for (const [name, method, symbol, args] of [
	["match", String.prototype.match, Symbol.match, []],
	["matchAll", String.prototype.matchAll, Symbol.matchAll, []],
	["search", String.prototype.search, Symbol.search, []],
	["replace", String.prototype.replace, Symbol.replace, ["x"]],
	["replaceAll", String.prototype.replaceAll, Symbol.replace, ["x"]],
	["split", String.prototype.split, Symbol.split, []],
]) {
	const argument = { [symbol]: 1 };
	check(
		name + " rejects a non-callable object symbol method",
		throwsTypeError(() => method.call("a1b1c", argument, ...args)),
	);
}

for (const [name, method, symbol, expected] of [
	["match", String.prototype.match, Symbol.match, "1"],
	["matchAll", String.prototype.matchAll, Symbol.matchAll, "1"],
	["search", String.prototype.search, Symbol.search, 1],
]) {
	for (const missing of [null, undefined]) {
		const argument = { [symbol]: missing, toString: () => "1" };
		const result = method.call("a1b1c", argument);
		const actual =
			name === "matchAll" ? [...result][0][0] : name === "match" ? result[0] : result;
		check(name + " falls back for a nullish object symbol method", actual === expected);
	}
}

const ownMatch = /a/;
let ownMatchCalls = 0;
ownMatch[Symbol.match] = function (value) {
	ownMatchCalls++;
	return value + ":own";
};
check(
	"match observes an own RegExp protocol method",
	"subject".match(ownMatch) === "subject:own" && ownMatchCalls === 1,
);

const originalSearch = RegExp.prototype[Symbol.search];
const getterSearch = /b/;
let searchGetterCalls = 0;
Object.defineProperty(getterSearch, Symbol.search, {
	configurable: true,
	get() {
		searchGetterCalls++;
		return originalSearch;
	},
});
check(
	"search observes an own RegExp protocol getter",
	"abc".search(getterSearch) === 1 && searchGetterCalls === 1,
);

const canonicalSearch = /b/g;
canonicalSearch.lastIndex = 2;
check(
	"canonical search returns only the index and restores lastIndex",
	"abc".search(canonicalSearch) === 1 && canonicalSearch.lastIndex === 2,
);
const stickySearch = /b/y;
stickySearch.lastIndex = 1;
check(
	"canonical sticky search starts at zero and restores lastIndex",
	"abc".search(stickySearch) === -1 && stickySearch.lastIndex === 1,
);

const customExecSearch = /b/;
let customExecCalls = 0;
customExecSearch.exec = function (value) {
	customExecCalls++;
	return { 0: "custom", index: 7, input: value, length: 1 };
};
check(
	"search preserves a canonical RegExp with an own exec override",
	"abc".search(customExecSearch) === 7 && customExecCalls === 1,
);

function projectedExec(regexp, value) {
	const match = regexp.exec(value);
	if (match === null) return "none";
	return match[1] + ":" + match[2] + ":" + match[3] + ":" + match[4];
}

check(
	"closed exec consumers preserve selected captures",
	projectedExec(/^(a)(b)(c)(d)$/, "abcd") === "a:b:c:d" &&
		projectedExec(/^(a)(b)(c)(d)$/, "abce") === "none",
);

function projectedScalars(regexp, value, mutate) {
	const match = regexp.exec(value);
	if (match === null) return "none";
	if (mutate) String.prototype.charCodeAt = () => 777;
	return match[1].length + ":" + match[2].charCodeAt(0);
}
const originalCharCodeAt = String.prototype.charCodeAt;
check(
	"closed exec scalar consumers preserve length and charCodeAt",
	projectedScalars(/^(ab)(c)$/, "abc", false) === "2:99",
);
check(
	"closed exec scalar consumers resurrect after method mutation",
	projectedScalars(/^(ab)(c)$/, "abc", true) === "2:777",
);
String.prototype.charCodeAt = originalCharCodeAt;
check(
	"closed exec scalar consumers preserve empty capture charCodeAt",
	(() => {
		const match = /^()(c)$/.exec("c");
		const value = match[1].charCodeAt(0);
		return value !== value;
	})(),
);

function projectedUnmatchedScalar(regexp, value) {
	const match = regexp.exec(value);
	if (match === null) return false;
	return match[1].length;
}
check(
	"closed exec scalar consumers preserve unmatched property throws",
	throwsTypeError(() => projectedUnmatchedScalar(/^(a)?b$/, "b")),
);

function projectedNumber(regexp, value) {
	const match = regexp.exec(value);
	if (match === null) return "none";
	return Number(match[1]);
}
check(
	"closed exec number consumers parse capture spans",
	projectedNumber(/^(.*)$/, "  -12.5e1  ") === -125 &&
		projectedNumber(/^(.*)$/, "0x10") === 16 &&
		projectedNumber(/^(.*)$/, "Infinity") === Infinity &&
		Object.is(projectedNumber(/^(.*)$/, "-0"), -0) &&
		projectedNumber(/^(.*)$/, "") === 0 &&
		Number.isNaN(projectedNumber(/^(.*)$/, "nope")),
);
check(
	"closed exec number consumers preserve unmatched undefined",
	Number.isNaN(projectedNumber(/^(a)?b$/, "b")),
);

function projectedOptional(regexp, value) {
	const match = regexp.exec(value);
	if (match === null) return false;
	return match[1] === undefined;
}
check(
	"closed exec consumers preserve unmatched captures",
	projectedOptional(/^(a)?b$/, "b"),
);

function projectedUnconditional(regexp, value) {
	const match = regexp.exec(value);
	return match[1];
}
let projectedNoMatchThrew = false;
try {
	projectedUnconditional(/(z)/, "a");
} catch (error) {
	projectedNoMatchThrew = error instanceof TypeError;
}
check(
	"projected no-match preserves an unconditional property throw",
	projectedNoMatchThrew,
);

function projectedOutOfRange(regexp, value) {
	const match = regexp.exec(value);
	if (match === null) return "none";
	return match[37];
}
let inheritedCaptureGets = 0;
const inheritedCapture = {};
const reentrantLastIndex = /a/;
reentrantLastIndex.lastIndex = {
	valueOf() {
		Object.defineProperty(Array.prototype, "37", {
			configurable: true,
			get() {
				inheritedCaptureGets++;
				return inheritedCapture;
			},
		});
		return 0;
	},
};
check(
	"projected exec materializes out-of-range inherited indices",
	projectedOutOfRange(reentrantLastIndex, "a") === inheritedCapture &&
		inheritedCaptureGets === 1,
);
delete Array.prototype[37];

const manyCaptures = new RegExp(`^${"(a)".repeat(37)}$`);
check(
	"projected exec supports heap-backed capture buffers",
	projectedOutOfRange(manyCaptures, "a".repeat(37)) === "a",
);

function projectedFirst(regexp, value) {
	const match = regexp.exec(value);
	if (match === null) return "none";
	return match[1];
}
const projectedGlobal = /(a)/g;
projectedGlobal.lastIndex = 1;
check(
	"projected exec preserves global lastIndex updates",
	projectedFirst(projectedGlobal, "ba") === "a" && projectedGlobal.lastIndex === 2,
);
const projectedSticky = /(a)/y;
projectedSticky.lastIndex = 1;
check(
	"projected exec preserves sticky no-match resets",
	projectedFirst(projectedSticky, "bb") === "none" && projectedSticky.lastIndex === 0,
);

const projectedCustomExec = /(a)/;
let projectedCustomCalls = 0;
projectedCustomExec.exec = function () {
	projectedCustomCalls++;
	return { 1: "custom" };
};
check(
	"projected exec falls back for an own exec override",
	projectedFirst(projectedCustomExec, "a") === "custom" && projectedCustomCalls === 1,
);

let projectedInputCoercions = 0;
const projectedInputObject = {
	toString() {
		projectedInputCoercions++;
		return "a";
	},
};
check(
	"projected exec falls back for input coercion",
	projectedFirst(/(a)/, projectedInputObject) === "a" && projectedInputCoercions === 1,
);

const projectedLastIndexError = {};
const projectedThrowingLastIndex = /(a)/g;
projectedThrowingLastIndex.lastIndex = {
	valueOf() {
		throw projectedLastIndexError;
	},
};
let projectedCaughtLastIndexError = false;
try {
	projectedFirst(projectedThrowingLastIndex, "a");
} catch (error) {
	projectedCaughtLastIndexError = error === projectedLastIndexError;
}
check(
	"projected exec preserves lastIndex coercion exceptions",
	projectedCaughtLastIndexError,
);

const originalMatch = RegExp.prototype[Symbol.match];
let prototypeMatchCalls = 0;
RegExp.prototype[Symbol.match] = function (value) {
	prototypeMatchCalls++;
	return value + ":prototype";
};
check(
	"match observes a replaced RegExp prototype method",
	"subject".match(/subject/) === "subject:prototype" && prototypeMatchCalls === 1,
);
RegExp.prototype[Symbol.match] = originalMatch;

const capturedMatch = /subject/;
const mutatingSubject = {
	toString() {
		capturedMatch[Symbol.match] = () => "late replacement";
		return "subject";
	},
};
const capturedResult = String.prototype.match.call(mutatingSubject, capturedMatch);
check(
	"match captures the protocol method before subject coercion",
	capturedResult[0] === "subject" &&
		"subject".match(capturedMatch) === "late replacement",
);

function projectedMatchAllNumbers(value, regexp) {
	let total = 0;
	let count = 0;
	for (const match of value.matchAll(regexp)) {
		total += Number(match[1]);
		count++;
	}
	return total + ":" + count;
}
check(
	"closed matchAll capture spans parse through Number",
	projectedMatchAllNumbers("a12a3", /a(\d+)/g) === "15:2",
);
check(
	"closed matchAll capture spans preserve unmatched undefined",
	projectedMatchAllNumbers("aa", /a(\d)?/g) === "NaN:2",
);
check(
	"closed matchAll capture spans advance empty unicode matches",
	projectedMatchAllNumbers("😀", /()/gu) === "0:2",
);
const projectedMatchAllOriginal = /a(\d)/g;
projectedMatchAllOriginal.lastIndex = 2;
check(
	"closed matchAll projection leaves the original lastIndex unchanged",
	projectedMatchAllNumbers("a1a2", projectedMatchAllOriginal) === "2:1" &&
		projectedMatchAllOriginal.lastIndex === 2,
);

const manualIterator = "aba".matchAll(/a/g);
const manualFirst = manualIterator.next();
const manualSecond = manualIterator.next();
check(
	"manual RegExp iterator next returns distinct result objects",
	manualFirst !== manualSecond &&
		manualFirst.value.index === 0 &&
		manualSecond.value.index === 2,
);

const overriddenIterator = "aba".matchAll(/a/g);
const originalNext = overriddenIterator.next;
let overriddenNextCalls = 0;
overriddenIterator.next = function () {
	overriddenNextCalls++;
	return originalNext.call(this);
};
check(
	"RegExp iteration observes an overridden next method",
	[...overriddenIterator].length === 2 && overriddenNextCalls === 3,
);

const capturedNextIterator = "aba".matchAll(/a/g);
let capturedNextCount = 0;
for (const match of capturedNextIterator) {
	capturedNextCount += match.index;
	capturedNextIterator.next = () => ({ done: true });
}
check(
	"RegExp iteration keeps its initially captured next method",
	capturedNextCount === 2,
);

let passed = 0;
for (const [name, condition] of results) {
	if (condition) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
