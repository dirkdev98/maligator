// HOF inlining for backward methods: reduceRight / findLast / findLastIndex.
(function () {
	const out = [];

	// reduceRight (with init) — right-to-left accumulation.
	out.push("rr:" + ["a", "b", "c"].reduceRight((a, x) => a + x, "X")); // X c b a → "Xcba"
	out.push("rrsum:" + [1, 2, 3, 4].reduceRight((a, x) => a - x, 0)); // 0-4-3-2-1 = -10
	out.push("rridx:" + [10, 20, 30].reduceRight((a, v, i) => a + i + ":" + v + " ", "")); // 2:30 1:20 0:10

	// reduceRight skips holes.
	out.push("rrhole:" + [1, , 3].reduceRight((a, x) => a + x, 0)); // 4

	// findLast — last element matching (backward), visits holes.
	out.push("fl:" + [1, 2, 3, 4, 5].findLast(x => x < 4)); // 3
	out.push("flnone:" + [1, 2, 3].findLast(x => x > 9)); // undefined
	out.push("flhole:" + [1, , 3].findLast(x => x === undefined)); // undefined (hole visited)

	// findLastIndex.
	out.push("fli:" + [1, 2, 3, 4, 5].findLastIndex(x => x < 4)); // 2
	out.push("flinone:" + [1, 2, 3].findLastIndex(x => x > 9)); // -1

	// Branching callback (multi-block fold) in findLast.
	out.push("flbranch:" + [1, 2, 3, 6, 7].findLast(n => {
		if (n % 2 === 0) {
			return true;
		}
		return false;
	})); // 6

	// reduceRight no init → slow path (first-from-right element seeds the accumulator).
	out.push("rrnoinit:" + [1, 2, 3].reduceRight((a, x) => a + "" + x)); // "321"

	// Monkey-patched → slow path.
	const mp = [1, 2, 3];
	mp.findLast = function () {
		return "patched";
	};
	out.push("mp:" + mp.findLast(x => x > 0));

	console.log(out.join(" | "));
})();
