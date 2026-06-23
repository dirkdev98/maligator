// HOF inlining for flatMap: map then flatten one level (the __arrayFlatMapAppend
// intrinsic does the depth-1 spread, so the closure folds away on the fast path).
(function () {
	const out = [];

	// Array results are spread one level.
	out.push("dup:" + [1, 2, 3].flatMap(x => [x, x]).join(",")); // 1,1,2,2,3,3

	// Mixed array / scalar results.
	out.push("mix:" + [1, 2, 3].flatMap(x => (x % 2 === 0 ? [x, x * 10] : x)).join(",")); // 1,2,20,3

	// Non-array results append as-is.
	out.push("scalar:" + [1, 2, 3].flatMap(x => x * 2).join(",")); // 2,4,6

	// Empty-array result contributes nothing.
	out.push("empty:" + [1, 2, 3].flatMap(x => (x === 2 ? [] : [x])).join(",")); // 1,3

	// Only one level of flattening: nested arrays stay nested.
	out.push("nest:" + JSON.stringify([1, 2].flatMap(x => [[x]]))); // [[1],[2]]

	// Index + array args reach the callback.
	out.push("args:" + [10, 20].flatMap((v, i, a) => [i + ":" + v + "/" + a.length]).join(",")); // 0:10/2,1:20/2

	// Holes in the source are skipped (no callback call).
	out.push("hole:" + [1, , 3].flatMap(x => [x, x]).join(",")); // 1,1,3,3

	// Holes inside a returned array are skipped by the flatten.
	out.push("innerhole:" + [1, 2].flatMap(x => (x === 1 ? [x, , x] : [x])).join(",")); // 1,1,2

	// Branching callback (multi-block fold).
	out.push("branch:" + [1, 2, 3, 4].flatMap(n => {
		if (n % 2 === 0) {
			return [n, -n];
		}
		return [n];
	}).join(",")); // 1,2,-2,3,4,-4

	// Empty source.
	out.push("src0:" + JSON.stringify([].flatMap(x => [x, x]))); // []

	// Monkey-patched → slow path.
	const mp = [1, 2, 3];
	mp.flatMap = function () {
		return "patched";
	};
	out.push("mp:" + mp.flatMap(x => [x]));

	console.log(out.join(" | "));
})();
