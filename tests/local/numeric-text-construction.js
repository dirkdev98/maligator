function check(condition, message) {
	if (!condition) throw new Error(message);
}

function collect() {
	const gc = globalThis.__mal_collect_garbage;
	if (typeof gc === "function") gc();
}

const cases = [
	[0, "0"],
	[-0, "0"],
	[-2147483648, "-2147483648"],
	[2147483647, "2147483647"],
	[4294967295, "4294967295"],
	[9007199254740991, "9007199254740991"],
	[1000000000000000100, "1000000000000000100"],
	[5e-324, "5e-324"],
	[-5e-324, "-5e-324"],
	[1e-7, "1e-7"],
	[1e-6, "0.000001"],
	[1e20, "100000000000000000000"],
	[1e21, "1e+21"],
	[1.7976931348623157e308, "1.7976931348623157e+308"],
	[NaN, "NaN"],
	[Infinity, "Infinity"],
	[-Infinity, "-Infinity"],
];
const numbers = cases.map((entry) => entry[0]);
const spellings = cases.map((entry) => entry[1]);
const jsonSpellings = cases.map((entry) =>
	Number.isFinite(entry[0]) ? entry[1] : "null",
);
const jsonExpected = "[" + jsonSpellings.join(",") + "]";
check(JSON.stringify(numbers) === jsonExpected, "plain numeric JSON spelling");
check(
	JSON.stringify(numbers, (_key, value) => value) === jsonExpected,
	"generic numeric JSON spelling",
);
check(
	new Float64Array(numbers).join("|") === spellings.join("|"),
	"Float64 numeric join spelling",
);
check(
	new Int32Array([-2147483648, 0, 2147483647]).join() === "-2147483648,0,2147483647",
	"Int32 join bounds",
);
check(
	new Uint32Array([0, 2147483648, 4294967295]).join(":") === "0:2147483648:4294967295",
	"Uint32 join bounds",
);
check(
	new Float32Array([-0, 1.25, NaN, Infinity, -Infinity]).join() ===
		"0,1.25,NaN,Infinity,-Infinity",
	"Float32 join special values",
);

const order = [];
const boxed = new Number(1);
boxed.valueOf = function () {
	order.push("valueOf");
	collect();
	return 1e21;
};
const transformed = {
	get value() {
		order.push("get");
		return {
			toJSON(key) {
				order.push("toJSON:" + key);
				collect();
				return boxed;
			},
		};
	},
};
check(
	JSON.stringify(transformed, function (key, value) {
		order.push("replacer:" + key);
		collect();
		return value;
	}) === '{"value":1e+21}',
	"numeric JSON observable conversions",
);
check(
	order.join("|") === "replacer:|get|toJSON:value|replacer:value|valueOf",
	"JSON callback order",
);
check(
	JSON.stringify({ text: "\ud800\u0100", number: -0 }, null, 1) ===
		'{\n "text": "\\ud800\u0100",\n "number": 0\n}',
	"numeric append after wide JSON content",
);

const separatorParts = ["latin\u00e9", "\ud800", "\u0100", "\udc00", "end"];
let separator = "";
for (let i = 0; i < 12; i++) separator += separatorParts[i % separatorParts.length];
const joined = new Float64Array([1.25, -0, 1e21]).join({
	toString() {
		collect();
		return separator;
	},
});
check(
	joined === "1.25" + separator + "0" + separator + "1e+21",
	"rope separator code units",
);
collect();
check(
	joined.charCodeAt(12) === separator.charCodeAt(8),
	"joined output survives collection",
);

const detached = new Uint8Array([1, 2, 3]);
check(
	detached.join({
		toString() {
			detached.buffer.transfer();
			collect();
			return "|";
		},
	}) === "||",
	"join keeps length and observes detachment during separator coercion",
);
const shrinkBuffer = new ArrayBuffer(4, { maxByteLength: 8 });
const shrinking = new Uint8Array(shrinkBuffer);
shrinking.set([7, 8, 9, 10]);
check(
	shrinking.join({
		toString() {
			shrinkBuffer.resize(2);
			return "|";
		},
	}) === "7|8||",
	"join observes a shorter tracking view after separator coercion",
);
const fixedBuffer = new ArrayBuffer(4, { maxByteLength: 8 });
const fixed = new Uint8Array(fixedBuffer, 0, 4);
check(
	fixed.join({
		toString() {
			fixedBuffer.resize(2);
			return ":";
		},
	}) === ":::",
	"join observes a fixed view becoming out of bounds",
);
const growBuffer = new ArrayBuffer(2, { maxByteLength: 8 });
const growing = new Uint8Array(growBuffer);
growing.set([3, 5]);
check(
	growing.join({
		toString() {
			growBuffer.resize(4);
			growing[2] = 9;
			return "|";
		},
	}) === "3|5",
	"join retains the initial length when separator grows the view",
);
let emptyConversions = 0;
check(
	new Uint8Array(0).join({
		toString() {
			emptyConversions++;
			return "/";
		},
	}) === "" && emptyConversions === 1,
	"empty join still coerces separator once",
);
const sentinel = {};
let thrown;
try {
	new Float64Array([1]).join({
		toString() {
			throw sentinel;
		},
	});
} catch (error) {
	thrown = error;
}
check(thrown === sentinel, "separator abrupt completion");
check(
	new BigInt64Array([-9223372036854775808n, 0n, 9223372036854775807n]).join("|") ===
		"-9223372036854775808|0|9223372036854775807",
	"BigInt join fallback",
);
check(
	new BigUint64Array([18446744073709551615n]).join(separator) === "18446744073709551615",
	"unsigned BigInt join fallback",
);
console.log("numeric-text-construction PASS");
