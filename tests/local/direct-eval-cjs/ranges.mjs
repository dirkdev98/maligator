// A generator traversal in an ES module that the CommonJS entry requires.

function* range(limit) {
	for (let index = 0; index < limit; index++) yield index * 2;
}

export function sumRanges(rounds) {
	let checksum = 0;
	for (let round = 0; round < rounds; round++)
		for (const value of range(round & 15)) checksum += value;
	return checksum;
}
