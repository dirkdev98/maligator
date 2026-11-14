// Other modules can drive or patch an exported generator, so the loops over it keep
// the iteration protocol. A generator only this module calls still fuses.
function* counts(limit) {
	for (let index = 0; index < limit; index++) yield index * 3;
}

function sumCounts(limit) {
	let sum = 0;
	for (const value of counts(limit)) sum += value;
	return sum;
}

function* privateSteps(seed) {
	for (let index = 0; index < 8; index++) yield (seed + index) & 63;
}

function sumPrivateSteps(rounds) {
	let sum = 0;
	for (let round = 0; round < rounds; round++)
		for (const value of privateSteps(round)) sum += value;
	return sum;
}

module.exports = { counts, sumCounts, sumPrivateSteps };
