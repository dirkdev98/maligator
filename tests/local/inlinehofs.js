// HOF inlining for some/every/find/findIndex — must match Node on both backends,
// including hole semantics (some/every skip holes; find/findIndex visit them).
(function () {
	const out = [];

	// some / every (capturing arrows).
	let threshold = 3;
	out.push("some>" + threshold + ":" + [1, 2, 3, 4].some(x => x > threshold)); // true
	out.push("some>9:" + [1, 2, 3].some(x => x > 9)); // false
	out.push("everyPos:" + [1, 2, 3].every(x => x > 0)); // true
	out.push("everyPos:" + [1, -2, 3].every(x => x > 0)); // false

	// find / findIndex.
	out.push("find>2:" + [1, 2, 3, 4].find(x => x > 2)); // 3
	out.push("find>9:" + [1, 2, 3].find(x => x > 9)); // undefined
	out.push("findIdx>2:" + [1, 2, 3, 4].findIndex(x => x > 2)); // 2
	out.push("findIdx>9:" + [1, 2, 3].findIndex(x => x > 9)); // -1

	// index + array args.
	out.push("someIdx:" + [10, 20, 30].some((v, i, a) => i === 1 && v === 20 && a.length === 3)); // true

	// HOLES: some/every SKIP holes; find/findIndex VISIT them (cb gets undefined).
	const sparse = [1, , 3]; // hole at index 1
	let sawHoleSome = false;
	sparse.some((v) => {
		if (v === undefined) sawHoleSome = true;
		return false;
	});
	out.push("someHole:" + sawHoleSome); // false (hole skipped)

	let sawHoleFind = false;
	sparse.find((v) => {
		if (v === undefined) sawHoleFind = true;
		return false;
	});
	out.push("findHole:" + sawHoleFind); // true (hole visited as undefined)

	// every short-circuits (does not call cb after first falsy).
	let everyCalls = 0;
	[1, 2, 3, 4].every(x => {
		everyCalls++;
		return x < 2;
	});
	out.push("everyCalls:" + everyCalls); // 2 (stops after x=2 returns false)

	// some short-circuits.
	let someCalls = 0;
	[1, 2, 3, 4].some(x => {
		someCalls++;
		return x === 2;
	});
	out.push("someCalls:" + someCalls); // 2

	// Branching callback (multi-block fold).
	out.push("findEven:" + [1, 3, 5, 6, 7].find(n => {
		if (n % 2 === 0) {
			return true;
		}
		return false;
	})); // 6

	// Monkey-patched → slow path.
	const mp = [1, 2, 3];
	mp.some = function () {
		return "patched";
	};
	out.push("mp:" + mp.some());

	console.log(out.join(" | "));
})();
