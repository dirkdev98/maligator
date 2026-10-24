function equal(actual, expected) {
	if (!Object.is(actual, expected)) throw new Error(`${actual} != ${expected}`);
}

const collect = globalThis.__mal_collect_garbage ?? globalThis.gc;
if (typeof collect !== "function") throw new Error("Missing collector");
function gate(value, selected) {
	collect();
	if (value && typeof value === "object" && value.marker !== undefined)
		equal(value.marker, "alive");
	return selected;
}

function stringDispatch(value, callback, flag) {
	const selected = flag ? value : "other";
	callback(value, selected);
	switch (selected) {
		case "load":
			return 0;
		case "save":
			return 1;
		case "a\0b":
			return 2;
		case "😀":
			return 3;
		default:
			return -1;
	}
}

function numberDispatch(value, callback, flag) {
	const selected = flag ? value : 0;
	callback(value, selected);
	switch (selected) {
		case -2147483648:
			return 10;
		case 0:
			return 11;
		case -0:
			return 99;
		case 1:
			return 12;
		case 2147483647:
			return 13;
		default:
			return -1;
	}
}

function bounded(input, callback) {
	const selected = input & 3;
	callback(input, selected);
	switch (selected) {
		case 0:
			return 20;
		case 1:
			return 21;
		case 2:
			return 22;
		case 9:
			throw new Error("Impossible range");
		default:
			return 23;
	}
}

function unsigned(input, callback) {
	const selected = input >>> 0;
	callback(input, selected);
	switch (selected) {
		case 0:
			return 30;
		case 1:
			return 31;
		case 9:
			return 32;
		case 2147483647:
			return 33;
		default:
			return 34;
	}
}

function nonString(input, callback, flag) {
	const selected = flag ? +input : null;
	callback(input, selected);
	switch (selected) {
		case "0":
			throw new Error("Number matched String");
		case "null":
			throw new Error("Null matched String");
		default:
			return 40;
	}
}

function nonNumber(input, callback, flag) {
	const selected = flag ? typeof input : null;
	callback(input, selected);
	switch (selected) {
		case 0:
			throw new Error("String matched Number");
		case 1:
			throw new Error("Null matched Number");
		default:
			return 41;
	}
}

function backedges(callback) {
	const live = { marker: "alive", total: 0 };
	for (let i = 0; i < 12; i++) {
		const selected = i & 3;
		callback(live, selected);
		switch (selected) {
			case 0:
				live.total += 1;
				continue;
			case 1:
				live.total += 2;
				continue;
			case 2:
				live.total += 3;
				break;
			case 9:
				throw new Error("Impossible loop range");
			default:
				live.total += 4;
				continue;
		}
		collect();
		equal(live.marker, "alive");
	}
	return live.total;
}

const strings = ["load", "save", "a\0b", "😀", "other"];
for (let i = 0; i < strings.length; i++) {
	const value = ("prefix" + strings[i]).slice(6);
	equal(stringDispatch(String(value), gate, true), i < 4 ? i : -1);
	equal(stringDispatch(value, gate, false), -1);
}
const numbers = [
	-2147483648,
	0,
	-0,
	1,
	2147483647,
	2147483648,
	4294967295,
	-2147483649,
	0.5,
	NaN,
	Infinity,
	-Infinity,
];
const expected = [10, 11, 11, 12, 13, -1, -1, -1, -1, -1, -1, -1];
for (let i = 0; i < numbers.length; i++) {
	equal(numberDispatch(+numbers[i], gate, true), expected[i]);
	equal(numberDispatch(numbers[i], gate, false), 11);
	equal(bounded(numbers[i], gate), 20 + (numbers[i] & 3));
	equal(nonString(numbers[i], gate, true), 40);
	equal(nonString(numbers[i], gate, false), 40);
	equal(nonNumber(numbers[i], gate, true), 41);
	equal(nonNumber(numbers[i], gate, false), 41);
}
for (const [value, result] of [
	[0, 30],
	[1, 31],
	[9, 32],
	[2147483647, 33],
	[-1, 34],
	[2147483648, 34],
	[4294967296, 30],
])
	equal(unsigned(value, gate), result);
let coercions = 0;
const object = {
	[Symbol.toPrimitive]() {
		coercions++;
		throw new Error("Unexpected coercion");
	},
};
for (const value of [object, Symbol("value"), null, undefined, 1n]) {
	equal(stringDispatch(value, gate, true), -1);
	equal(numberDispatch(value, gate, true), -1);
}
equal(coercions, 0);
equal(backedges(gate), 30);
const originalString = String;
if (Object.getOwnPropertyDescriptor(globalThis, "String").writable) {
	try {
		globalThis.String = () => object;
		equal(stringDispatch(String("load"), gate, true), -1);
		globalThis.String = () => Symbol("replacement");
		equal(stringDispatch(String("load"), gate, true), -1);
		globalThis.String = () => {
			throw new Error("replacement");
		};
		let caught = false;
		try {
			stringDispatch(String("load"), gate, true);
		} catch (error) {
			caught = error.message === "replacement";
		}
		equal(caught, true);
	} finally {
		globalThis.String = originalString;
	}
}
console.log("switch-selector-facts PASS");
