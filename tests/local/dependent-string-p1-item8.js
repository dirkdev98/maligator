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

const indexed = indexedCharacter();
const nestedIndexed = nestedIndexedCharacter();
const boxed = boxedCharacter();
const iterated = iteratedCodePoint();
const extracted = arrayExtract();
const spreadArray = arraySpread();
const spreadObject = objectSpread();
const restObject = objectRest();

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
ok("all dependent and cons paths ran", passed === 17);

console.log("dependent-string-p1-item8 PASS");
