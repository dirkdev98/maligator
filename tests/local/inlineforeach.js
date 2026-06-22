// HOF forEach inlining: each case must match Node exactly on both backends.
(function () {
	const out = [];

	// Basic: capturing arrow accumulator.
	let sum = 0;
	[1, 2, 3, 4].forEach(x => {
		sum += x;
	});
	out.push("sum=" + sum);

	// index + array args.
	const parts = [];
	["a", "b", "c"].forEach((v, i, arr) => {
		parts.push(i + ":" + v + "/" + arr.length);
	});
	out.push(parts.join(","));

	// Sparse array — forEach must SKIP holes (not call cb with undefined).
	const sparse = [10, , 30]; // hole at index 1
	const visited = [];
	sparse.forEach((v, i) => {
		visited.push(i + "=" + v);
	});
	out.push("sparse:" + visited.join(","));

	// Callback with a branch (multi-block cb folded into the loop).
	let evens = 0;
	let odds = 0;
	[1, 2, 3, 4, 5, 6].forEach(n => {
		if (n % 2 === 0) {
			evens += n;
		} else {
			odds += n;
		}
	});
	out.push("evens=" + evens + " odds=" + odds);

	// Nested forEach.
	let grid = "";
	[1, 2].forEach(a => {
		[10, 20].forEach(b => {
			grid += a + "+" + b + "=" + (a + b) + " ";
		});
	});
	out.push("grid:" + grid.trim());

	// Mutation during iteration: length captured once; later elements live.
	const mut = [1, 2, 3];
	const seen = [];
	mut.forEach((v, i) => {
		seen.push(v);
		if (i === 0) {
			mut.push(99); // not visited (length captured)
			mut[2] = 33; // visited (live get)
		}
	});
	out.push("mut:" + seen.join(",") + " len=" + mut.length);

	// forEach return value is undefined.
	const r = [1].forEach(() => {});
	out.push("ret=" + r);

	// Monkey-patched forEach → guard must fall back to the patched method.
	const patched = [1, 2, 3];
	patched.forEach = function () {
		return "patched!";
	};
	out.push("mp=" + patched.forEach());

	console.log(out.join(" | "));
})();
