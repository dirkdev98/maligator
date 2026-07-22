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

function throwsTypeError(callback) {
	try {
		callback();
	} catch (error) {
		return error instanceof TypeError;
	}
	return false;
}

let inheritedSetterCalls = 0;
let setterResult;
Object.defineProperty(Array.prototype, "0", {
	configurable: true,
	set() {
		inheritedSetterCalls++;
	},
});
setterResult = "left,right".split(",");
delete Array.prototype[0];
check(
	"split creates index zero without invoking an inherited setter",
	inheritedSetterCalls === 0 &&
		setterResult.length === 2 &&
		setterResult[0] === "left" &&
		setterResult[1] === "right" &&
		Object.hasOwn(setterResult, 0),
);

let nonWritableResult;
Object.defineProperty(Array.prototype, "1", {
	configurable: true,
	writable: false,
	value: "inherited",
});
nonWritableResult = "a,b,c".split(",");
delete Array.prototype[1];
check(
	"split creates own elements over inherited non-writable data",
	nonWritableResult.length === 3 &&
		nonWritableResult[1] === "b" &&
		Object.hasOwn(nonWritableResult, 1),
);

const descriptorResult = "alpha,beta".split(",");
const descriptor = Object.getOwnPropertyDescriptor(descriptorResult, "0");
const independentResult = "alpha,beta".split(",");
check(
	"split returns a distinct intrinsic ordinary Array",
	Array.isArray(descriptorResult) &&
		Object.getPrototypeOf(descriptorResult) === Array.prototype &&
		descriptorResult !== independentResult,
);
check(
	"split elements have CreateDataProperty attributes",
	descriptor !== undefined &&
		descriptor.value === "alpha" &&
		descriptor.writable === true &&
		descriptor.enumerable === true &&
		descriptor.configurable === true &&
		descriptorResult.length === 2,
);

check(
	"undefined separator keeps the receiver",
	"abc".split(undefined).join("|") === "abc",
);
check("omitted separator keeps the receiver", "abc".split().join("|") === "abc");
check("zero limit is empty", "a,b".split(",", 0).length === 0);
check("one limit stops after one segment", "a,b,c".split(",", 1).join("|") === "a");
check("finite limit stops exactly", "a,b,c".split(",", 2).join("|") === "a|b");
check(
	"wrapped negative limit is effectively unbounded",
	"a,b".split(",", -1).length === 2,
);
check("infinite limit converts to zero", "a,b".split(",", Infinity).length === 0);
check("empty separator splits code units", "abc".split("").join("|") === "a|b|c");
check("empty source with empty separator is empty", "".split("").length === 0);
check(
	"empty source with non-empty separator has one segment",
	"".split(",").join("|") === "",
);
check(
	"multi-unit adjacent and trailing separators are preserved",
	"a--b----".split("--").join("|") === "a|b||",
);
check(
	"leading adjacent and trailing separators are preserved",
	",a,,b,".split(",").join("|") === "|a||b|",
);

const surrogateParts = "\ud83d\ude00".split("");
check(
	"empty separator splits a surrogate pair into UTF-16 code units",
	surrogateParts.length === 2 &&
		surrogateParts[0].charCodeAt(0) === 0xd83d &&
		surrogateParts[1].charCodeAt(0) === 0xde00,
);
check(
	"multi-unit separator can contain a surrogate pair",
	"a\ud83d\ude00b\ud83d\ude00".split("\ud83d\ude00").join("|") === "a|b|",
);

const largeResult = ("item,".repeat(8192) + "last").split(",");
check(
	"large split results retain every dense element and length",
	largeResult.length === 8193 &&
		largeResult[0] === "item" &&
		largeResult[4096] === "item" &&
		largeResult[8192] === "last" &&
		Object.keys(largeResult).length === 8193,
);

let order = "";
const orderedReceiver = {
	toString() {
		order += "receiver,";
		return "a,b,c";
	},
};
const orderedSeparator = {
	get [Symbol.split]() {
		order += "split-get,";
		return undefined;
	},
	toString() {
		order += "separator,";
		return ",";
	},
};
const orderedLimit = {
	valueOf() {
		order += "limit,";
		return 2;
	},
};
const orderedResult = String.prototype.split.call(
	orderedReceiver,
	orderedSeparator,
	orderedLimit,
);
check(
	"split protocol and coercions use exact fallback order",
	order === "split-get,receiver,limit,separator," && orderedResult.join("|") === "a|b",
);

let nullSeparatorLookup = 0;
const nullSeparator = {};
Object.defineProperty(nullSeparator, Symbol.split, {
	get() {
		nullSeparatorLookup++;
		return undefined;
	},
});
check(
	"RequireObjectCoercible precedes separator protocol lookup",
	throwsTypeError(() => String.prototype.split.call(null, nullSeparator)) &&
		nullSeparatorLookup === 0,
);

let zeroOrder = "";
const zeroLimit = {
	valueOf() {
		zeroOrder += "limit,";
		return 0;
	},
};
const zeroSeparator = {
	toString() {
		zeroOrder += "separator,";
		return ",";
	},
};
const zeroResult = "a,b".split(zeroSeparator, zeroLimit);
check(
	"separator coercion occurs after limit coercion even for zero limit",
	zeroOrder === "limit,separator," && zeroResult.length === 0,
);

let primitiveSplitLookup = 0;
Object.defineProperty(String.prototype, Symbol.split, {
	configurable: true,
	get() {
		primitiveSplitLookup++;
		throw new Error("primitive Symbol.split getter called");
	},
});
const primitiveResult = "a,b".split(",");
delete String.prototype[Symbol.split];
check(
	"primitive separators skip Symbol.split lookup",
	primitiveSplitLookup === 0 && primitiveResult.join("|") === "a|b",
);

const customResult = {};
let customThis;
let customSubject;
let customLimit;
const customSeparator = {
	[Symbol.split](subject, limit) {
		customThis = this;
		customSubject = subject;
		customLimit = limit;
		return customResult;
	},
};
const customSubjectObject = {
	toString() {
		throw new Error("custom split coerced subject");
	},
};
check(
	"custom Symbol.split remains generic and receives original values",
	String.prototype.split.call(customSubjectObject, customSeparator, 7) === customResult &&
		customThis === customSeparator &&
		customSubject === customSubjectObject &&
		customLimit === 7,
);

const proxyResult = {};
let proxyGets = 0;
const proxySeparator = new Proxy(
	{
		[Symbol.split]() {
			return proxyResult;
		},
	},
	{
		get(target, key) {
			if (key === Symbol.split) proxyGets++;
			return Reflect.get(target, key);
		},
	},
);
check(
	"proxy separator protocol lookup remains generic",
	"subject".split(proxySeparator) === proxyResult && proxyGets === 1,
);
check(
	"RegExp split remains on the RegExp protocol path",
	"a1b22c".split(/[0-9]+/).join("|") === "a|b|c",
);

let churnChecksum = 0;
for (let i = 0; i < 400; i++) {
	const parts = ("a,b,c,d,e,f,g,h," + i).split(",");
	churnChecksum += parts.length + parts[8].length;
}
check("repeated split results survive collector activity", churnChecksum === 4690);

console.log("string-split-fresh-array PASS " + passed + "/" + total);
