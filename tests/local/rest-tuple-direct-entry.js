let passed = 0;

function check(condition, label) {
	if (!condition) throw new Error(`rest-tuple-direct-entry: ${label}`);
	passed++;
}

function reduceRest(rounds, ...values) {
	let sum = 0;
	for (let round = 0; round < rounds; round++) {
		for (let index = 0; index < values.length; index++) sum += values[index];
	}
	return sum;
}

function reduceRestCachedLength(rounds, ...values) {
	let sum = 0;
	const length = values.length;
	for (let round = 0; round < rounds; round++) {
		for (let index = 0; index < length; index++) sum += values[index];
	}
	return sum;
}

for (let index = 0; index < 8; index++) {
	check(reduceRest(3, 2, 3, 5, 7) === 51, "uncached exact tuple");
	check(reduceRestCachedLength(3, 2, 3, 5, 7) === 51, "cached exact tuple");
}

const fallback = [reduceRest, reduceRestCachedLength];
check(fallback[0](2, 11, 13) === 48, "uncached generic arity");
check(fallback[1](2, 11, 13) === 48, "cached generic arity");

console.log(`rest-tuple-direct-entry PASS ${passed}`);
