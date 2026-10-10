const MOD = 1_000_000_007;
const show = (value) =>
	typeof value === "bigint" ? `${value}n` : Object.is(value, -0) ? "-0" : String(value);
function accumulate(source, count) {
	let checksum = 0;
	for (let index = 0; index < count; index++) checksum = (checksum + source(index)) % MOD;
	return checksum;
}
function negateSum(source, count) {
	let total = 0;
	for (let index = 0; index < count; index++) total = total - -source(index);
	return total;
}
function concatenate(left, right) {
	let text = left;
	for (let index = 0; index < 3; index++) text = text + right;
	return text;
}
const sources = {
	number: (index) => index * 3.5,
	string: (index) => `${index}`,
	numericObject: (index) => ({ valueOf: () => index * 2 }),
	stringObject: (index) => ({ toString: () => `${index}0`, valueOf: undefined }),
	negativeZero: () => -0,
	mixed: (index) =>
		index % 3 === 0 ? `${index}` : index % 3 === 1 ? index : { valueOf: () => -index },
};
for (const [name, source] of Object.entries(sources)) {
	console.log(name, show(accumulate(source, 2_000)), show(negateSum(source, 50)));
}
for (const value of [5n, { valueOf: () => 7n }, Symbol("s")]) {
	try {
		console.log("accumulate", show(accumulate(() => value, 3)));
	} catch (error) {
		console.log("accumulate", error.constructor.name);
	}
	try {
		console.log("negate", show(negateSum(() => value, 3)));
	} catch (error) {
		console.log("negate", error.constructor.name);
	}
}
console.log(
	show(concatenate(1n, "x")),
	show(concatenate("x", 2n)),
	show(concatenate(1n, 2n)),
);
console.log(show(concatenate(1, { toString: () => "!", valueOf: undefined })));
function bigintSum(count) {
	let total = 0n;
	for (let index = 0; index < count; index++) total = total - -BigInt(index);
	return total;
}
console.log(show(bigintSum(100)));
console.log(
	["4", "", " 2 ", true, null, undefined, { valueOf: () => "8" }, { valueOf: () => 3n }]
		.map((value) => show(-value))
		.join(" "),
);
