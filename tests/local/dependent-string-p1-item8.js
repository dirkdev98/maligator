let passed = 0;

function ok(name, condition) {
	if (!condition) throw new Error("FAIL " + name);
	passed++;
}

function makeSource(middle) {
	return "left-" + middle + "-right";
}

function indexedCharacter() {
	const source = makeSource("indexed");
	return source[7];
}

function nestedIndexedCharacter() {
	const source = makeSource("nested");
	return source[5][0];
}

function boxedCharacter() {
	const source = Object(makeSource("boxed"));
	return source[6];
}

function iteratedCodePoint() {
	const source = makeSource("\ud83d\ude00tail");
	const iterator = source[Symbol.iterator]();
	for (let i = 0; i < 5; i++) iterator.next();
	return iterator.next().value;
}

function arrayExtract() {
	const source = makeSource("array");
	return Array.prototype.slice.call(source, 5, 10);
}

function arraySpread() {
	const source = makeSource("spread");
	return [...source].slice(5, 11);
}

function objectSpread() {
	const source = makeSource("object");
	return { ...source };
}

function objectRest() {
	const source = makeSource("rest");
	const { 0: omitted, ...rest } = source;
	return { omitted, rest };
}

function directStringSlices() {
	const source = "  " + ("alpha-" + "beta") + "  ";
	return {
		charAt: source.charAt(2),
		at: source.at(-3),
		slice: source.slice(2, 7),
		substring: source.substring(8, 12),
		substr: source.substr(2, 10),
		trim: source.trim(),
		trimStart: source.trimStart(),
		trimEnd: source.trimEnd(),
		split: source.split("-"),
		full: source.slice(0),
		empty: source.substring(4, 4),
	};
}

function regexpSlices() {
	const source = "prefix:" + "id=alpha,value=12345" + ":suffix";
	const exec = /id=(?<name>[a-z]+),value=([0-9]+)/.exec(source);
	const all = [];
	for (const match of source.matchAll(/([a-z]+)=([a-z0-9]+)/g)) {
		all.push(match);
	}
	return {
		exec,
		global: source.match(/[a-z]+/g),
		all,
		split: source.split(/([,:])/),
		empty: /^/.exec(source),
		optional: /(z)?prefix/.exec(source),
	};
}

function retainedTinySlices() {
	const source = "x".repeat(8192) + "-kept";
	return [source.slice(-4), source[0]];
}

function nestedNonzeroSlice() {
	const first = makeSource("abcdef").slice(5, 11);
	return first.slice(2, 5);
}

function substantialLargeSlice() {
	const source = "a".repeat(8192) + "b".repeat(8192);
	return source.slice(4096, 12288);
}

const indexed = indexedCharacter();
const nestedIndexed = nestedIndexedCharacter();
const boxed = boxedCharacter();
const iterated = iteratedCodePoint();
const extracted = arrayExtract();
const spreadArray = arraySpread();
const spreadObject = objectSpread();
const restObject = objectRest();
const direct = directStringSlices();
const regexp = regexpSlices();
const tiny = retainedTinySlices();
const nestedSlice = nestedNonzeroSlice();
const largeSlice = substantialLargeSlice();

let deep = "x";
for (let i = 0; i < 4096; i++) deep = deep + String.fromCharCode(97 + (i % 26));
const deepExpectedSuffix = "yzabcdefghijklmn";

const sharedPrefix = "shared-" + "prefix";
const sharedLeft = sharedPrefix + "-left";
const sharedRight = sharedPrefix + "-right";

const splitSurrogate = "\ud83d" + "\ude00";
const numericRope = "12" + "34";
const propertyRope = "rope-" + "key";
const keyed = { [propertyRope]: 42 };

let doubled = "z";
for (let i = 0; i < 12; i++) doubled = doubled + doubled;

const largePowerRepeat = "abcd".repeat(1 << 14);
const largePowerSlices = [
	largePowerRepeat.slice(0, 7),
	largePowerRepeat.slice((1 << 15) - 3, (1 << 15) + 5),
	largePowerRepeat.slice(-7),
];
const ownedSurrogateSource = String.fromCharCode(0xd83d, 0xde00, 0x78);
const largeNonPowerRepeat = ownedSurrogateSource.repeat(21847);
const nonPowerBoundary = 10923 * ownedSurrogateSource.length;
const largeNonPowerSlices = [
	largeNonPowerRepeat.slice(0, 3),
	largeNonPowerRepeat.slice(nonPowerBoundary - 2, nonPowerBoundary + 4),
	largeNonPowerRepeat.slice(-3),
];
const largePropertyKey = "key:".repeat(1 << 14);
const largePropertyLookup = "key:".repeat(1 << 14);
const largeKeyed = { [largePropertyKey]: 99 };

const gc = globalThis.__mal_collect_garbage;
if (typeof gc === "function") {
	gc();
	gc();
}

ok("primitive indexed character", indexed === "d");
ok("dependent parent is flattened", nestedIndexed === "n");
ok("boxed indexed character", boxed === "o");
ok("iterator surrogate pair", iterated === "\ud83d\ude00");
ok("array extraction", extracted.join("") === "array");
ok("array spread", spreadArray.join("") === "spread");
ok(
	"object spread",
	spreadObject[5] +
		spreadObject[6] +
		spreadObject[7] +
		spreadObject[8] +
		spreadObject[9] +
		spreadObject[10] ===
		"object",
);
ok(
	"object rest",
	restObject.omitted === "l" &&
		restObject.rest[5] + restObject.rest[6] + restObject.rest[7] + restObject.rest[8] ===
			"rest",
);
ok(
	"deep left-associated rope",
	deep.length === 4097 && deep.slice(-16) === deepExpectedSuffix,
);
ok("shared prefix left", sharedLeft === "shared-prefix-left");
ok("shared prefix right", sharedRight === "shared-prefix-right");
ok(
	"surrogate pair split across children",
	splitSurrogate.length === 2 && [...splitSurrogate][0] === "\ud83d\ude00",
);
ok("rope numeric conversion", Number(numericRope) === 1234);
ok("rope property key", keyed["rope-key"] === 42);
ok("rope regexp boundary", /^rope-key$/.test(propertyRope));
ok("rope JSON boundary", JSON.stringify(splitSurrogate) === '"\ud83d\ude00"');
ok("shared DAG flatten", doubled.length === 4096 && doubled[4095] === "z");
ok(
	"large power-of-two repeat slices before flatten",
	largePowerRepeat.length === 1 << 16 &&
		largePowerSlices[0] === "abcdabc" &&
		largePowerSlices[1] === "bcdabcda" &&
		largePowerSlices[2] === "bcdabcd",
);
ok(
	"large non-power-of-two surrogate repeat slices before flatten",
	largeNonPowerRepeat.length === 65541 &&
		largeNonPowerSlices[0] === ownedSurrogateSource &&
		largeNonPowerSlices[1] === "\ude00x\ud83d\ude00x\ud83d" &&
		largeNonPowerSlices[2] === ownedSurrogateSource,
);
let largePowerScan = true;
for (let i = 0; i < largePowerRepeat.length; i++) {
	if (largePowerRepeat.charCodeAt(i) !== 97 + (i % 4)) largePowerScan = false;
}
ok("large shared power-of-two DAG full scan", largePowerScan);
const surrogateCodeUnits = [0xd83d, 0xde00, 0x78];
let largeNonPowerScan = true;
for (let i = 0; i < largeNonPowerRepeat.length; i++) {
	if (largeNonPowerRepeat.charCodeAt(i) !== surrogateCodeUnits[i % 3]) {
		largeNonPowerScan = false;
	}
}
ok("large mixed surrogate DAG full scan", largeNonPowerScan);
ok(
	"large repeated property key hash",
	largeKeyed[largePropertyLookup] === 99 && largePropertyLookup.length === 1 << 16,
);
ok("String.prototype.charAt slice", direct.charAt === "a");
ok("String.prototype.at slice", direct.at === "a");
ok("String.prototype.slice", direct.slice === "alpha");
ok("String.prototype.substring", direct.substring === "beta");
ok("String.prototype.substr", direct.substr === "alpha-beta");
ok(
	"String.prototype trim variants",
	direct.trim === "alpha-beta" &&
		direct.trimStart === "alpha-beta  " &&
		direct.trimEnd === "  alpha-beta",
);
ok(
	"String.prototype.split slices",
	direct.split.length === 2 &&
		direct.split[0] === "  alpha" &&
		direct.split[1] === "beta  ",
);
ok(
	"String full and empty slices",
	direct.full === "  alpha-beta  " && direct.empty === "",
);
ok(
	"RegExp exec full and numbered captures",
	regexp.exec[0] === "id=alpha,value=12345" &&
		regexp.exec[1] === "alpha" &&
		regexp.exec[2] === "12345",
);
ok("RegExp named capture", regexp.exec.groups.name === "alpha");
ok(
	"RegExp global match slices",
	regexp.global.join("|") === "prefix|id|alpha|value|suffix",
);
ok(
	"RegExp matchAll capture slices",
	regexp.all.length === 2 &&
		regexp.all[0][1] === "id" &&
		regexp.all[0][2] === "alpha" &&
		regexp.all[1][1] === "value" &&
		regexp.all[1][2] === "12345",
);
ok(
	"RegExp split gap and capture slices",
	regexp.split.join("|") === "prefix|:|id=alpha|,|value=12345|:|suffix",
);
ok(
	"RegExp empty and unmatched captures",
	regexp.empty[0] === "" &&
		regexp.optional[0] === "prefix" &&
		regexp.optional[1] === undefined,
);
ok("tiny slice values", tiny[0] === "kept" && tiny[1] === "x");
ok("nested dependent nonzero offset", nestedSlice === "cde");
ok(
	"substantial large slice",
	largeSlice.length === 8192 && largeSlice.charAt(0) === "a" && largeSlice.at(-1) === "b",
);
ok("all dependent, copied-slice, and cons paths ran", passed === 39);

console.log("dependent-string-p1-item8 PASS");
