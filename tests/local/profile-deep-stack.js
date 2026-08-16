function work(seed) {
	let checksum = seed >>> 0;
	for (let index = 0; index < 40_000_000; index++) {
		checksum = (Math.imul(checksum, 1_664_525) + 1_013_904_223) >>> 0;
	}
	return checksum;
}

function descend(depth) {
	if (depth === 0) {
		return work(1);
	}
	return (descend(depth - 1) + depth) >>> 0;
}

console.log(descend(320));
