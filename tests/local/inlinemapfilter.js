// HOF inlining for map/filter — must match Node on both backends, including the
// result-array semantics (map preserves length+holes; filter is dense) and species.
(function () {
	const out = [];

	// Basic map (capturing arrow).
	let k = 10;
	out.push("map:" + [1, 2, 3].map(x => x + k).join(","));

	// map with index + array.
	out.push("mapIdx:" + [5, 6, 7].map((v, i, a) => i + ":" + v + "/" + a.length).join(","));

	// filter.
	out.push("filter:" + [1, 2, 3, 4, 5, 6].filter(x => x % 2 === 0).join(","));
	out.push("filterNone:" + JSON.stringify([1, 2, 3].filter(() => false)));
	out.push("filterAll:" + [1, 2, 3].filter(() => true).join(","));

	// map preserves holes AND length: [1,,3].map → [2, <hole>, 6], length 3.
	const m = [1, , 3].map(x => x * 2);
	out.push("mapHoleLen:" + m.length + " has1:" + (1 in m) + " vals:" + m[0] + "," + m[2]);

	// filter SKIPS holes (does not include them).
	const f = [1, , 3].filter(() => true);
	out.push("filterHole:" + f.length + ":" + f.join(","));

	// map returns a NEW array (not the source).
	const src = [1, 2, 3];
	const mapped = src.map(x => x);
	out.push("newArr:" + (mapped !== src) + " srcLen:" + src.length);

	// Branching callback (multi-block fold) in map.
	out.push("mapBranch:" + [1, 2, 3, 4].map(n => {
		if (n % 2 === 0) {
			return "e" + n;
		}
		return "o" + n;
	}).join(","));

	// Nested map.
	out.push("nested:" + [1, 2].map(a => [10, 20].map(b => a + b).join("+")).join(" "));

	// Subclass: my inlining must DEFER to the slow path (guard rejects non-default
	// species). Maligator has a pre-existing gap where runtime map doesn't preserve
	// subclass species, so compare the inlinable result to the (skipped) non-inlinable
	// one — they must match, proving the inline defers rather than changing behavior.
	class MyArr extends Array {}
	const sub = MyArr.from([1, 2, 3]);
	const subInlinable = sub.map(x => x * 10).join(",");
	const subDeferred = sub.map(function (x) { return this, x * 10; }).join(","); // `this` → not inlinable
	out.push("species:" + (subInlinable === subDeferred) + ":" + subInlinable);

	// Monkey-patched map → slow path.
	const mp = [1, 2, 3];
	mp.map = function () {
		return "patched";
	};
	out.push("mp:" + mp.map());

	console.log(out.join(" | "));
})();
