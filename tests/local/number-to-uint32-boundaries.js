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
console.log("RESULT " + checks + "/" + (cases.length * 6 + 2));
