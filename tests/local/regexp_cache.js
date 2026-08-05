const results = [];

function check(name, condition) {
	results.push([name, condition]);
}

function caught(fn) {
	try {
		fn();
	} catch (error) {
		return error;
	}
	return undefined;
}

const objects = [];
for (let i = 0; i < 100; i++) objects.push(new RegExp("(a)(b)?", "g"));

check("fresh objects keep distinct identity", objects[0] !== objects[1]);

const first = objects[0];
const second = objects[1];
first.lastIndex = 1;
second.lastIndex = 0;
const firstMatch = first.exec("zab");
const secondMatch = second.exec("a");
check(
	"shared patterns keep independent lastIndex",
	first.lastIndex === 3 && second.lastIndex === 1,
);
check(
	"shared patterns keep independent captures",
	firstMatch[0] === "ab" &&
		firstMatch[2] === "b" &&
		secondMatch[0] === "a" &&
		secondMatch[2] === undefined,
);

check(
	"different flags do not alias",
	!new RegExp("a").test("A") && new RegExp("a", "i").test("A"),
);

const fastRecord = /^level=([A-Z]+);user=([a-z]+)-([0-9]+);action=([a-z]+);/.exec(
	"level=INFO;user=alpha-17;action=read;tail",
);
check(
	"literal and range captures preserve exact ranges",
	fastRecord[0] === "level=INFO;user=alpha-17;action=read;" &&
		fastRecord[1] === "INFO" &&
		fastRecord[2] === "alpha" &&
		fastRecord[3] === "17" &&
		fastRecord[4] === "read",
);

const fastGlobal = /value=([0-9]+)/g;
const fastGlobalFirst = fastGlobal.exec("value=12;value=345");
const fastGlobalSecond = fastGlobal.exec("value=12;value=345");
const fastGlobalDone = fastGlobal.exec("value=12;value=345");
check(
	"literal and range plans preserve global lastIndex",
	fastGlobalFirst.index === 0 &&
		fastGlobalFirst[1] === "12" &&
		fastGlobalSecond.index === 9 &&
		fastGlobalSecond[1] === "345" &&
		fastGlobalDone === null &&
		fastGlobal.lastIndex === 0,
);

const fastSticky = /[a-z]+/y;
fastSticky.lastIndex = 1;
const fastStickyMatch = fastSticky.exec("0alpha");
fastSticky.lastIndex = 0;
const fastStickyMiss = fastSticky.exec("0alpha");
check(
	"range plans preserve sticky anchoring",
	fastStickyMatch[0] === "alpha" &&
		fastStickyMatch.index === 1 &&
		fastStickyMiss === null &&
		fastSticky.lastIndex === 0,
);

const fastIndices = /value=([0-9]+)/d.exec("prefix value=42 suffix");
check(
	"literal and range plans preserve match indices",
	fastIndices.indices[0][0] === 7 &&
		fastIndices.indices[0][1] === 15 &&
		fastIndices.indices[1][0] === 13 &&
		fastIndices.indices[1][1] === 15,
);

check(
	"backtracking-sensitive plans retain general semantics",
	/([a-z]+)a/.exec("za")[1] === "z",
);
check("negated classes retain general semantics", /[^-z]+/.exec("ABC")[0] === "ABC");

check(
	"canonical flags preserve specification order",
	new RegExp("a", "ymig").flags === "gimy",
);

const canonicalMatchAll = /a/g;
canonicalMatchAll.lastIndex = 1;
const canonicalMatches = [..."baab".matchAll(canonicalMatchAll)];
check(
	"canonical matchAll copies but does not update the original lastIndex",
	canonicalMatches.length === 2 &&
		canonicalMatches[0].index === 1 &&
		canonicalMatches[1].index === 2 &&
		canonicalMatchAll.lastIndex === 1,
);

const customFlags = /a/g;
let customFlagsCalls = 0;
Object.defineProperty(customFlags, "flags", {
	configurable: true,
	get() {
		customFlagsCalls++;
		return "g";
	},
});
const customFlagsMatches = [..."aba".matchAll(customFlags)];
check(
	"matchAll observes an own flags getter",
	customFlagsCalls === 2 && customFlagsMatches.length === 2,
);

const flagsMarker = {};
const throwingFlags = /a/g;
let throwingFlagsSubjectCalls = 0;
Object.defineProperty(throwingFlags, "flags", {
	configurable: true,
	get() {
		throw flagsMarker;
	},
});
const throwingFlagsError = caught(() =>
	String.prototype.matchAll.call(
		{
			toString() {
				throwingFlagsSubjectCalls++;
				return "a";
			},
		},
		throwingFlags,
	),
);
check(
	"a throwing flags getter runs before subject coercion",
	throwingFlagsError === flagsMarker && throwingFlagsSubjectCalls === 0,
);

const customExec = /a/;
let customExecCalls = 0;
customExec.exec = function () {
	customExecCalls++;
	return { 0: "custom", index: 0, length: 1 };
};
check(
	"RegExp test observes an own exec method",
	customExec.test("miss") && customExecCalls === 1,
);

const ownMatchAll = /a/g;
const ownMatchAllResult = {};
let ownMatchAllCalls = 0;
ownMatchAll[Symbol.matchAll] = function (value) {
	ownMatchAllCalls++;
	return value === "subject" ? ownMatchAllResult : undefined;
};
check(
	"matchAll observes a symbol property in RegExp overflow storage",
	"subject".matchAll(ownMatchAll) === ownMatchAllResult && ownMatchAllCalls === 1,
);

const proxyTarget = /a/g;
let proxyMatchReads = 0;
let proxyFlagsReads = 0;
let proxyMatchAllCalls = 0;
const proxyRegExp = new Proxy(proxyTarget, {
	get(target, key, receiver) {
		if (key === Symbol.match) {
			proxyMatchReads++;
			return true;
		}
		if (key === "flags") {
			proxyFlagsReads++;
			return "g";
		}
		if (key === Symbol.matchAll) {
			return function (value) {
				proxyMatchAllCalls++;
				return RegExp.prototype[Symbol.matchAll].call(target, value);
			};
		}
		return Reflect.get(target, key, receiver);
	},
});
const proxyMatches = [..."aba".matchAll(proxyRegExp)];
check(
	"matchAll preserves proxy protocol traps",
	proxyMatchReads === 1 &&
		proxyFlagsReads === 1 &&
		proxyMatchAllCalls === 1 &&
		proxyMatches.length === 2,
);

const speciesRegExp = /a/g;
let speciesCalls = 0;
let speciesPattern;
let speciesFlags;
function MatchAllSpecies(pattern, flags) {
	speciesCalls++;
	speciesPattern = pattern;
	speciesFlags = flags;
	return new RegExp(pattern, flags);
}
speciesRegExp.constructor = { [Symbol.species]: MatchAllSpecies };
const speciesMatches = [..."aba".matchAll(speciesRegExp)];
check(
	"matchAll observes an own species constructor",
	speciesCalls === 1 &&
		speciesPattern === speciesRegExp &&
		speciesFlags === "g" &&
		speciesMatches.length === 2,
);

const convertedLastIndex = /a/g;
let lastIndexConversions = 0;
const convertedLastIndexValue = {
	valueOf() {
		lastIndexConversions++;
		return 1;
	},
};
convertedLastIndex.lastIndex = convertedLastIndexValue;
const convertedLastIndexMatches = [..."ba".matchAll(convertedLastIndex)];
check(
	"canonical matchAll preserves lastIndex conversion",
	lastIndexConversions === 1 &&
		convertedLastIndexMatches.length === 1 &&
		convertedLastIndexMatches[0].index === 1 &&
		convertedLastIndex.lastIndex === convertedLastIndexValue,
);

const lastIndexMarker = {};
const throwingLastIndex = /a/g;
throwingLastIndex.lastIndex = {
	valueOf() {
		throw lastIndexMarker;
	},
};
check(
	"canonical matchAll preserves throwing lastIndex conversion",
	caught(() => [..."a".matchAll(throwingLastIndex)]) === lastIndexMarker,
);

let subclassSpeciesCalls = 0;
class MatchAllRegExpSubclass extends RegExp {
	static get [Symbol.species]() {
		subclassSpeciesCalls++;
		return RegExp;
	}
}
const subclassRegExp = new MatchAllRegExpSubclass("a", "g");
const subclassMatches = [..."aba".matchAll(subclassRegExp)];
check(
	"matchAll preserves RegExp subclass species",
	subclassSpeciesCalls === 1 && subclassMatches.length === 2,
);

const customPrototype = Object.create(RegExp.prototype);
let prototypeFlagsCalls = 0;
Object.defineProperty(customPrototype, "flags", {
	configurable: true,
	get() {
		prototypeFlagsCalls++;
		return "g";
	},
});
const customPrototypeRegExp = /a/g;
Object.setPrototypeOf(customPrototypeRegExp, customPrototype);
const customPrototypeMatches = [..."aba".matchAll(customPrototypeRegExp)];
check(
	"matchAll observes a changed instance prototype",
	prototypeFlagsCalls === 2 && customPrototypeMatches.length === 2,
);

let accessorLastIndexCalls = 0;
const accessorLastIndexReceiver = {
	[Symbol.match]: true,
	constructor: RegExp,
	flags: "g",
	source: "a",
	get lastIndex() {
		accessorLastIndexCalls++;
		return 1;
	},
};
const accessorLastIndexMatches = [
	...RegExp.prototype[Symbol.matchAll].call(accessorLastIndexReceiver, "ba"),
];
check(
	"generic matchAll observes a lastIndex accessor",
	accessorLastIndexCalls === 1 &&
		accessorLastIndexMatches.length === 1 &&
		accessorLastIndexMatches[0].index === 1,
);

const accessorMarker = {};
const throwingAccessorReceiver = {
	[Symbol.match]: true,
	constructor: RegExp,
	flags: "g",
	source: "a",
	get lastIndex() {
		throw accessorMarker;
	},
};
check(
	"generic matchAll preserves a throwing lastIndex accessor",
	caught(() => RegExp.prototype[Symbol.matchAll].call(throwingAccessorReceiver, "a")) ===
		accessorMarker,
);

const nonExtensibleRegExp = /a/g;
Object.preventExtensions(nonExtensibleRegExp);
check(
	"matchAll preserves non-extensible RegExp behavior",
	[..."aba".matchAll(nonExtensibleRegExp)].length === 2,
);

if (typeof ShadowRealm === "function") {
	const realmMatchAll = new ShadowRealm().evaluate(`() => {
		const regexp = /a/g;
		regexp.lastIndex = 1;
		const matches = [..."ba".matchAll(regexp)];
		return matches.length === 1 && matches[0].index === 1 && regexp.lastIndex === 1;
	}`);
	check("canonical matchAll uses its active realm", realmMatchAll() === true);
}

const locked = /a/g;
locked.lastIndex = 2;
const writableDescriptor = Object.getOwnPropertyDescriptor(locked, "lastIndex");
Object.defineProperty(locked, "lastIndex", { writable: false });
const lockedSet = Reflect.set(locked, "lastIndex", 7);
const lockedDescriptor = Object.getOwnPropertyDescriptor(locked, "lastIndex");
check(
	"lastIndex updates preserve descriptor state",
	writableDescriptor.value === 2 &&
		writableDescriptor.writable === true &&
		writableDescriptor.enumerable === false &&
		writableDescriptor.configurable === false &&
		lockedSet === false &&
		lockedDescriptor.value === 2 &&
		lockedDescriptor.writable === false &&
		lockedDescriptor.enumerable === false &&
		lockedDescriptor.configurable === false,
);

const shaped = /a/g;
shaped.extra = 1;
let incompatibleLastIndex = false;
try {
	Object.defineProperty(shaped, "lastIndex", {
		value: 1,
		writable: true,
		enumerable: true,
		configurable: true,
	});
} catch (error) {
	incompatibleLastIndex = error instanceof TypeError;
}
check(
	"lastIndex keeps non-default own-property semantics",
	Reflect.ownKeys(shaped)[0] === "lastIndex" &&
		Object.keys(shaped).join(",") === "extra" &&
		Reflect.deleteProperty(shaped, "lastIndex") === false &&
		incompatibleLastIndex &&
		shaped.lastIndex === 0,
);

let invalidCount = 0;
for (let i = 0; i < 2; i++) {
	try {
		new RegExp("(");
	} catch (error) {
		if (error instanceof SyntaxError) invalidCount++;
	}
}
check("invalid patterns still throw", invalidCount === 2);

const originalPrototypeFlags = Object.getOwnPropertyDescriptor(RegExp.prototype, "flags");
let replacedPrototypeFlagsCalls = 0;
Object.defineProperty(RegExp.prototype, "flags", {
	configurable: true,
	get() {
		replacedPrototypeFlagsCalls++;
		return "g";
	},
});
const replacedPrototypeFlagsMatches = [..."aba".matchAll(/a/g)];
check(
	"matchAll observes a replaced prototype flags getter",
	replacedPrototypeFlagsCalls === 2 && replacedPrototypeFlagsMatches.length === 2,
);
Object.defineProperty(RegExp.prototype, "flags", originalPrototypeFlags);

const originalPrototypeExec = RegExp.prototype.exec;
let replacedPrototypeExecCalls = 0;
RegExp.prototype.exec = function (value) {
	replacedPrototypeExecCalls++;
	return originalPrototypeExec.call(this, value);
};
const replacedPrototypeExecMatches = [..."aba".matchAll(/a/g)];
check(
	"matchAll observes a replaced prototype exec method",
	replacedPrototypeExecCalls === 3 && replacedPrototypeExecMatches.length === 2,
);
RegExp.prototype.exec = originalPrototypeExec;

let passed = 0;
for (const [name, condition] of results) {
	if (condition) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
