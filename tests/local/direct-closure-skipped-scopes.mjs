// `record` captures the wrapper and `checker` but not `outer`, whose scope sits between them.
const run = (() => {
	const scale = 3;
	function outer(seed) {
		const offset = seed * 2;
		function checker(limit, keep) {
			const pending = [];
			function record(value) {
				pending.push(value * scale);
				return pending.length;
			}
			function shift(value) {
				return value + offset;
			}
			function hold(callback) {
				return callback;
			}
			let total = 0;
			for (let index = 0; index < limit; index++) total += record(index) + shift(index);
			const kept = keep ? hold(record) : undefined;
			return [
				total,
				pending.length,
				kept === (keep ? record : undefined),
				kept?.name ?? "-",
			].join(":");
		}
		return checker;
	}
	return (rounds) => {
		const results = [];
		for (let round = 0; round < rounds; round++)
			results.push(outer(round)(4 + (round % 3), round % 5 === 0));
		return results;
	};
})();

const results = run(3000);
console.log(results.length, results[0], results[1], results[2999]);
console.log(results.slice(0, 6).join(" "));
