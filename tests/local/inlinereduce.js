// HOF reduce inlining (with-init fast path; no-init defers to slow path).
(function () {
	const out = [];

	// Basic sum with initial value.
	out.push("sum:" + [1, 2, 3, 4].reduce((a, x) => a + x, 0));

	// Capturing + index + array args.
	let base = 100;
	out.push("idx:" + [10, 20, 30].reduce((a, v, i, arr) => a + ":" + (base + v) + "@" + i + "/" + arr.length, "s"));

	// String accumulation.
	out.push("concat:" + ["a", "b", "c"].reduce((a, x) => a + x, "X"));

	// reduce over holes — must SKIP holes.
	out.push("hole:" + [1, , 3].reduce((a, x) => a + x, 0)); // 4 (hole skipped)

	// Branching callback (multi-block fold).
	out.push("branch:" + [1, 2, 3, 4, 5].reduce((a, n) => {
		if (n % 2 === 0) {
			return a + n;
		}
		return a;
	}, 0)); // 2+4 = 6

	// Object accumulator.
	const counts = ["x", "y", "x", "z", "x"].reduce((acc, k) => {
		acc[k] = (acc[k] || 0) + 1;
		return acc;
	}, {});
	out.push("counts:" + counts.x + counts.y + counts.z);

	// NO initial value → slow path (first element is the accumulator).
	out.push("noinit:" + [5, 6, 7].reduce((a, x) => a + x));

	// NO initial value, single element → returns that element (no cb call).
	out.push("single:" + [42].reduce((a, x) => a + x));

	// Empty + no init → TypeError (slow path).
	let threw = false;
	try {
		[].reduce((a, x) => a + x);
	} catch (e) {
		threw = e instanceof TypeError;
	}
	out.push("emptythrow:" + threw);

	// Monkey-patched reduce → slow path.
	const mp = [1, 2, 3];
	mp.reduce = function () {
		return "patched";
	};
	out.push("mp:" + mp.reduce((a, x) => a + x, 0));

	console.log(out.join(" | "));
})();
