// down and across share one owner layout, so their creator tests its chain once.
const run = (() => {
	const scale = 3;
	function outer(seed) {
		const offset = seed * 2;
		function checker(limit) {
			const pending = [];
			function down(value) {
				return value <= 0 ? offset + pending.length + scale : down(value - 1) + 1;
			}
			function across(value) {
				return value <= 0 ? offset - pending.length + scale : across(value - 2) + down(1);
			}
			let total = 0;
			for (let index = 0; index < limit; index++) total += down(index) + across(index);
			pending.push(total);
			return total;
		}
		return checker;
	}
	return (rounds) => {
		let sum = 0;
		for (let round = 0; round < rounds; round++) sum += outer(round)(4);
		return sum;
	};
})();
console.log(run(1000));
