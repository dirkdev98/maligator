// Implicit-arguments allocation benchmark. Direct static reads across omitted,
// unary, binary, and wider call shapes can use frame metadata/values without
// materializing an arguments object or retained argument slice. Normal/default
// calls cover the hot stack path; generators expose heap-resident buffers.

const MOD = 1000000007;

function count(value = 5) {
	return (arguments.length * 33 + value) % MOD;
}

function first(value = 7) {
	const firstValue = arguments.length === 0 ? value : arguments[0];
	return (firstValue * 17 + value) % MOD;
}

function edges(value = 11) {
	const firstValue = arguments.length > 0 ? arguments[0] : value;
	const secondValue = arguments.length > 1 ? arguments[1] : 13;
	const fourthValue = arguments.length > 3 ? arguments[3] : 19;
	return (firstValue * 3 + secondValue * 5 + fourthValue * 7 + arguments.length) % MOD;
}

function* countSequence(value = 23) {
	yield (arguments.length * 7 + value) % MOD;
}

function* firstSequence(value = 29) {
	const firstValue = arguments.length === 0 ? value : arguments[0];
	yield (firstValue * 11 + value + arguments.length) % MOD;
}

let checksum = 0;
for (let i = 0; i < 4800000; i++) {
	if ((i & 3) === 0) {
		checksum = (checksum + count() + first() + edges()) % MOD;
	} else if ((i & 3) === 1) {
		checksum = (checksum + count(i) + first(i) + edges(i)) % MOD;
	} else if ((i & 3) === 2) {
		checksum = (checksum + count(i, i + 1) + first(i, i + 1) + edges(i, i + 1)) % MOD;
	} else {
		checksum =
			(checksum +
				count(i, i + 1, i + 2, i + 3) +
				first(i, i + 1, i + 2) +
				edges(i, i + 1, i + 2, i + 3)) %
			MOD;
	}
}
for (let i = 0; i < 200000; i++) {
	const countIterator =
		i % 3 === 0
			? countSequence()
			: i % 3 === 1
				? countSequence(i)
				: countSequence(i, i + 1, i + 2);
	const firstIterator =
		i % 3 === 0
			? firstSequence()
			: i % 3 === 1
				? firstSequence(i)
				: firstSequence(i, i + 1);
	checksum = (checksum + countIterator.next().value + firstIterator.next().value) % MOD;
}

const EXPECTED_CHECKSUM = 526392284;
if (checksum !== EXPECTED_CHECKSUM) {
	throw new Error("arguments checksum " + checksum + " expected " + EXPECTED_CHECKSUM);
}
console.log(checksum);
