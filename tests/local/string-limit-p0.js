const results = [];

function check(name, condition) {
	results.push([name, condition]);
}

function throwsRangeError(fn) {
	try {
		fn();
	} catch (error) {
		return error instanceof RangeError;
	}
	return false;
}

check(
	"repeat rejects impossible length",
	throwsRangeError(() => "ab".repeat(1e9)),
);
check(
	"repeat measures UTF-16 code units",
	throwsRangeError(() => "\ud83d\ude00".repeat(1e9)),
);
check(
	"padStart rejects impossible length",
	throwsRangeError(() => "x".padStart(1e9, "0")),
);
check(
	"padEnd rejects impossible length",
	throwsRangeError(() => "x".padEnd(1e9, "0")),
);

// Build exact-limit values once so producers that add their own delimiters can
// exercise the catchable boundary without attempting an impossible allocation.
const halfLimit = "x".repeat(1 << 23);
const atLimit = halfLimit + halfLimit;
check("exact string limit remains valid", atLimit.length === 1 << 24);
check(
	"concat rejects one code unit past the limit",
	throwsRangeError(() => atLimit + "x"),
);
check(
	"Array join rejects delimiter overflow",
	throwsRangeError(() => [halfLimit, halfLimit].join()),
);
const localeHalf = { toLocaleString: () => halfLimit };
check(
	"Array toLocaleString rejects delimiter overflow",
	throwsRangeError(() => [localeHalf, localeHalf].toLocaleString()),
);
const gcJoin = [
	{ toString: () => "a".repeat(1024) },
	{
		toString() {
			if (typeof $262 !== "undefined") $262.gc();
			return "b";
		},
	},
].join("");
check("Array join roots earlier coerced strings", gcJoin === "a".repeat(1024) + "b");
const gcLocale = [
	{ toLocaleString: () => "c".repeat(1024) },
	{
		toLocaleString() {
			if (typeof $262 !== "undefined") $262.gc();
			return "d";
		},
	},
].toLocaleString();
check("Array toLocaleString roots earlier results", gcLocale === "c".repeat(1024) + ",d");
check(
	"Error toString rejects framing overflow",
	throwsRangeError(() => Error.prototype.toString.call({ name: atLimit, message: "x" })),
);
const stackError = new Error();
stackError.name = atLimit;
stackError.message = "";
check(
	"Error stack append rejects framing overflow",
	throwsRangeError(() => stackError.stack),
);
function namedAtLimit() {}
Object.defineProperty(namedAtLimit, "name", { value: atLimit, configurable: true });
check(
	"bound function name rejects framing overflow",
	throwsRangeError(() => namedAtLimit.bind(null)),
);
check(
	"computed symbol function name rejects framing overflow",
	throwsRangeError(() => ({ [Symbol(atLimit)]() {} })),
);
check(
	"Object toStringTag rejects framing overflow",
	throwsRangeError(() =>
		Object.prototype.toString.call({ [Symbol.toStringTag]: atLimit }),
	),
);
check(
	"Symbol toString rejects framing overflow",
	throwsRangeError(() => Symbol(atLimit).toString()),
);
check(
	"typed-array join rejects separator overflow",
	throwsRangeError(() => new Uint8Array(2).join(atLimit)),
);
let jsonGetterCalls = 0;
const jsonValue = {};
Object.defineProperty(jsonValue, "first", {
	enumerable: true,
	get() {
		jsonGetterCalls++;
		return atLimit;
	},
});
Object.defineProperty(jsonValue, "second", {
	enumerable: true,
	get() {
		jsonGetterCalls++;
		return 1;
	},
});
check(
	"JSON stringify rejects quoted overflow without continuing getters",
	throwsRangeError(() => JSON.stringify(jsonValue)) && jsonGetterCalls === 1,
);

let execCalls = 0;
const captureBomb = /x/g;
captureBomb.exec = function () {
	if (execCalls++ !== 0) return null;
	return { 0: "x", index: 0, length: 1e9, groups: undefined };
};
check(
	"regexp replacement rejects impossible capture arguments",
	throwsRangeError(() => captureBomb[Symbol.replace]("x", "$1")),
);

check(
	"encodeURIComponent rejects expansion past the limit",
	throwsRangeError(() => encodeURIComponent("%".repeat(1 << 23))),
);
check(
	"btoa rejects expansion past the limit",
	throwsRangeError(() => btoa(atLimit)),
);
check(
	"typed-array hex rejects expansion past the limit",
	throwsRangeError(() => new Uint8Array((1 << 23) + 1).toHex()),
);
check(
	"typed-array base64 rejects expansion past the limit",
	throwsRangeError(() => new Uint8Array(12582913).toBase64()),
);
check(
	"typed-array base64 remains correct",
	new Uint8Array([102, 111, 111]).toBase64() === "Zm9v" &&
		new Uint8Array([102]).toBase64() === "Zg==",
);
check("typed-array hex remains correct", new Uint8Array([0, 255]).toHex() === "00ff");

check("concat remains correct", "a" + "\ud83d\ude00" + "b" === "a\ud83d\ude00b");
check(
	"String.prototype.concat remains correct",
	"a".concat("\ud83d\ude00", "b") === "a\ud83d\ude00b",
);
check("empty String.prototype.concat remains correct", "".concat("") === "");
check("string replacement remains correct", "aba".replaceAll("a", "$&$") === "a$ba$");
check("regexp replacement remains correct", "aba".replace(/(a)/g, "$1$") === "a$ba$");

let passed = 0;
for (const [name, condition] of results) {
	if (condition) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
