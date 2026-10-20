// The owner reads `step` from its binding after `total` runs, so it calls through the cell.
function check(limit, values) {
	let calls = 0;
	function step(value) {
		calls++;
		return value > limit ? step(value - limit) + 1 : value;
	}
	function total() {
		let sum = 0;
		for (const value of values) sum += step(value);
		return sum;
	}
	const first = total();
	const again = step(limit * 2 + 1);
	const strings = values.map((value) => `${value}`);
	return [first, again, calls, strings.join("")].join(":");
}

const results = [];
for (let round = 0; round < 2000; round++)
	results.push(check(3 + (round % 4), [1, 5, 9, round % 11]));
console.log(results.length, results[0], results[1999]);
console.log(results.slice(0, 8).join(" "));
