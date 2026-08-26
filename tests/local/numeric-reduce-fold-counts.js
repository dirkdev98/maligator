// Repeat the same dense Number reduction enough times to exercise optimized and
// interpreted execution under stress collection.
function run() {
	const values = [];
	for (let index = 0; index < 100; index++) values.push(index / 100);
	let total = 0;
	for (let round = 0; round < 50; round++) {
		total += values.reduce(
			(sum, value) => sum + Math.sqrt(value) * Math.sin(value) + Math.abs(value - 0.5),
			0,
		);
	}
	return total;
}

const first = run();
const second = run();
if (!Object.is(first, second) || !(first > 0)) {
	throw new Error(`numeric reduce fold result ${first}/${second}`);
}

console.log("numeric-reduce-fold-counts PASS 1/1");
