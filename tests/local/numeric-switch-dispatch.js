function dense(value) {
	let result = 0;
	switch (value) {
		case -2:
			result += 1;
		case -1:
			result += 2;
			break;
		default:
			result = 90;
			break;
		case 0:
			result = 4;
			break;
		case -0:
			result = 999;
			break;
		case 1:
			result = 5;
		case 2:
			result += 6;
			break;
		case 3:
			result = 7;
			break;
	}
	return result;
}
function sparse(value) {
	switch (value) {
		case -2147483648:
			return 11;
		case -32767:
			return 12;
		case 0:
			return 13;
		case 65537:
			return 14;
		case 2147483647:
			return 15;
		default:
			return 16;
	}
}
function mixed(value) {
	switch (value) {
		case 0:
			return 21;
		case "0":
			return 22;
		case false:
			return 23;
		case null:
			return 24;
		default:
			return 25;
	}
}
function backedges(limit) {
	let total = 0;
	for (let i = 0; i < limit; i++) {
		switch (i & 7) {
			case 0:
				total += 1;
				continue;
			case 1:
				total += 2;
				continue;
			case 2:
				total += 3;
				continue;
			case 3:
				total += 4;
				continue;
			default:
				total += 5;
		}
	}
	return total;
}
function check(actual, expected) {
	if (actual !== expected) throw new Error(actual + " != " + expected);
}
let coercions = 0;
const object = {
	valueOf() {
		coercions++;
		return 0;
	},
	toString() {
		coercions++;
		return "0";
	},
};
const values = [
	-2,
	-1,
	0,
	-0,
	1,
	2,
	3,
	0.5,
	NaN,
	Infinity,
	-Infinity,
	2147483648,
	-2147483649,
	"0",
	false,
	null,
	undefined,
	object,
	-2147483648,
	-32767,
	65537,
	2147483647,
];
const denseExpected = [
	3, 2, 4, 4, 11, 6, 7, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90,
];
const sparseExpected = [
	16, 16, 13, 13, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 11, 12, 14, 15,
];
for (let round = 0; round < 20; round++) {
	for (let i = 0; i < values.length; i++) {
		check(dense(values[i]), denseExpected[i]);
		check(sparse(values[i]), sparseExpected[i]);
	}
	check(mixed(0), 21);
	check(mixed("0"), 22);
	check(mixed(false), 23);
	check(mixed(null), 24);
	check(mixed(object), 25);
	const surrounding = { value: backedges(800) };
	check(surrounding.value, 3000);
}
check(coercions, 0);
console.log("numeric-switch-dispatch PASS");
