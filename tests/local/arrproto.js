// Stress the array fast-elements protector: appends must still honor an inherited
// indexed setter, a custom prototype, and prototype pollution.
(function () {
	const out = [];
	const log = (l, v) => out.push(l + ":" + v);

	// Fast append before any pollution (protector holds).
	const a = [];
	for (let i = 0; i < 5; i++) a[i] = i * 2;
	log("fast", a.join(",") + "/" + a.length);

	// Inherited DATA on Array.prototype: a fresh index store shadows it (own prop),
	// a missing index reads through to it.
	Array.prototype[7] = "proto7";
	const b = [1, 2];
	log("inheritread", b[7]);          // proto7 (inherited)
	b[7] = "own7";                     // creates own, shadows inherited
	log("inheritwrite", b[7] + "/" + b.hasOwnProperty(7)); // own7/true
	log("protostill", [9][7]);         // proto7 (other array still inherits)
	delete Array.prototype[7];

	// Inherited SETTER on Array.prototype: a fresh-index store MUST invoke it, not
	// create an own property. (Defining it invalidated the protector.)
	let captured = null;
	Object.defineProperty(Array.prototype, "3", {
		set(v) { captured = v; },
		get() { return "getter3"; },
		configurable: true,
	});
	const c = [10, 20]; // length 2; index 3 is fresh
	c[3] = 99;
	log("setter", captured + "/" + c.hasOwnProperty(3) + "/" + c[3]); // 99/false/getter3
	delete Array.prototype[3];

	// Overwrite of a PRESENT element still shadows any inherited accessor (sound
	// even with the protector dirtied above).
	const d = [1, 2, 3];
	Object.defineProperty(Array.prototype, "1", { set() { captured = "WRONG"; }, configurable: true });
	captured = "unset";
	d[1] = 555; // d already owns index 1 → overwrite, setter NOT invoked
	log("overwrite", d[1] + "/" + captured); // 555/unset
	delete Array.prototype[1];

	// Custom prototype: fast path skipped, still correct.
	const e = [1, 2];
	Object.setPrototypeOf(e, { 9: "customproto" });
	log("customproto", e[9] + "/" + (e[0] + e[1])); // customproto/3
	e[5] = "x";
	log("customset", e[5] + "/" + e.length); // x/6

	console.log(out.join(" | "));
})();
