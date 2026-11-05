const cases = JSON.parse(`[
	["0", 0],
	["-0", 0],
	["0.75", 0],
	["-0.75", 0],
	["1.75", 1],
	["-1.75", 4294967295],
	["2147483647.75", 2147483647],
	["2147483648", 2147483648],
	["-2147483648", 2147483648],
	["-2147483649", 2147483647],
	["4294967295", 4294967295],
	["4294967295.75", 4294967295],
	["4294967296", 0],
	["4294967296.75", 0],
	["4294967297.75", 1],
	["-4294967295.75", 1],
	["-4294967296", 0],
	["-4294967296.75", 0],
	["-4294967297.75", 4294967295],
	["9007199254740991", 4294967295],
	["9007199254740992", 0],
	["9007199254740994", 2],
	["-9007199254740991", 1],
	["9223372036854774784", 4294966272],
	["9223372036854775808", 0],
	["9223372036854777856", 2048],
	["-9223372036854774784", 1024],
	["-9223372036854775808", 0],
	["-9223372036854777856", 4294965248],
	["1.7976931348623157e308", 0],
	["-1.7976931348623157e308", 0],
	["NaN", 0],
	["Infinity", 0],
	["-Infinity", 0]
]`);
const words = new Uint32Array(1);
const view = new DataView(new ArrayBuffer(4));
let checks = 0;

function equal(actual, expected, label) {
	if (!Object.is(actual, expected)) {
		throw new Error(label + ": " + actual + " !== " + expected);
	}
	checks++;
}

for (const [source, expected] of cases) {
	const value = Number(source);
	const signed = expected >= 2147483648 ? expected - 4294967296 : expected;
	equal(value >>> 0, expected, source + " shift");
	equal(Math.imul(value, 1), signed, source + " imul");
	words[0] = value;
	equal(words[0], expected, source + " typed array");
	view.setUint32(0, value);
	equal(view.getUint32(0), expected, source + " data view");
	let conversions = 0;
	const object = {
		valueOf() {
			conversions++;
			return value;
		},
	};
	equal(Math.imul(object, 1), signed, source + " object");
	equal(conversions, 1, source + " conversion count");
}

let order = "";
const left = {
	valueOf() {
		order += "left";
		return NaN;
	},
};
const right = {
	valueOf() {
		order += "right";
		return 3;
	},
};
equal(Math.imul(left, right), 0, "NaN product");
equal(order, "leftright", "coercion order");
function chainedLowBits(input, delta) {
	let value = input | 0;
	const step = delta | 0;
	value = (value + step) ^ 1;
	value = (value + step) ^ 2;
	value = (value + step) ^ 3;
	value = (value + step) ^ 4;
	value = (value + step) ^ 5;
	value = (value + step) ^ 6;
	value = (value + step) ^ 7;
	value = (value + step) ^ 8;
	return value;
}

function constantLowBits(input) {
	let value = input | 0;
	value = (value + 1) ^ 1;
	value = (value + 2) ^ 2;
	value = (value + 3) ^ 3;
	value = (value + 4) ^ 4;
	value = (value + 5) ^ 5;
	value = (value + 6) ^ 6;
	value = (value + 7) ^ 7;
	value = (value + 8) ^ 8;
	return value;
}

const wideCases = JSON.parse(
	`[[-2147483648,-2147483648,-2147483640],[-2147483648,-1,2147483640],[-2147483648,0,-2147483640],[-2147483648,1,-2147483632],[-2147483648,2147483647,2147483640],[-1,-2147483648,-9],[-1,-1,-17],[-1,0,-9],[-1,1,7],[-1,2147483647,-17],[0,-2147483648,8],[0,-1,-8],[0,0,8],[0,1,16],[0,2147483647,-8],[1,-2147483648,9],[1,-1,9],[1,0,9],[1,1,1],[1,2147483647,9],[2147483647,-2147483648,2147483639],[2147483647,-1,2147483631],[2147483647,0,2147483639],[2147483647,1,-2147483641],[2147483647,2147483647,2147483631]]`,
);
for (const [left, right, expected] of wideCases) {
	equal(
		chainedLowBits(left, right),
		expected,
		"wide integer chain " + left + "," + right,
	);
}

const constantCases = JSON.parse(
	`[[-2147483648,-2147483648],[-1,47],[0,0],[1,41],[2147483647,-2147483601]]`,
);
for (const [input, expected] of constantCases) {
	equal(constantLowBits(input), expected, "constant integer chain " + input);
}

function upperSafeWord(input) {
	return ((input >>> 0) + 9007194959773696) | 0;
}

function lowerSafeWord(input) {
	return ((input >>> 0) - 9007199254740991) | 0;
}

const safeEdgeCases = JSON.parse(
	`[[0,0,1],[1,1,2],[2147483647,2147483647,-2147483648],[2147483648,-2147483648,-2147483647],[4294967295,-1,0]]`,
);
for (const [input, upper, lower] of safeEdgeCases) {
	equal(upperSafeWord(input), upper, "upper safe word " + input);
	equal(lowerSafeWord(input), lower, "lower safe word " + input);
}

console.log(
	"RESULT " +
		checks +
		"/" +
		(cases.length * 6 +
			2 +
			wideCases.length +
			constantCases.length +
			safeEdgeCases.length * 2),
);
