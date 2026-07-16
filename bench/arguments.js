// Isolated implicit-arguments allocation benchmark. Direct, non-escaping reads
// can use frame metadata/values without materializing an arguments object.
// Length-only calls also need no retained argument slice. Normal/default calls
// cover the hot stack path; generators expose heap-resident buffer allocation.

const MOD = 1000000007;

function count(value) {
	return (arguments.length * 33 + value) % MOD;
}

function first(value = 0) {
	return (arguments[0] * 17 + value) % MOD;
}

function* countSequence(value) {
	yield (arguments.length * 7 + value) % MOD;
}

function* firstSequence(value) {
	yield (arguments[0] * 11 + value) % MOD;
}

let checksum = 0;
for (let i = 0; i < 750000; i++) {
	checksum = (checksum + count(i, i + 1, i + 2, i + 3)) % MOD;
	checksum = (checksum + first(i, i + 1, i + 2)) % MOD;
}
for (let i = 0; i < 50000; i++) {
	checksum = (checksum + countSequence(i, i + 1, i + 2).next().value) % MOD;
	checksum = (checksum + firstSequence(i, i + 1, i + 2).next().value) % MOD;
}

console.log(checksum);
