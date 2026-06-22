// Exercises the multi-block try-skip: `risky` is a branching/throwing local
// function. Called OUTSIDE a try it is multi-block-inlined; called INSIDE a try it
// must NOT be (relocating its throw would escape the handler). Both must match Node.
(function () {
	function risky(x) {
		if (x < 0) throw "neg:" + x;
		if (x === 0) return "zero";
		return "pos:" + x;
	}

	const out = [];

	// Outside any try: inlined. Only non-negative inputs so it returns normally.
	out.push(risky(0));
	out.push(risky(7));

	// Inside a try: must keep working as a real call so the throw is caught.
	for (let i = -2; i <= 2; i++) {
		try {
			out.push(risky(i));
		} catch (e) {
			out.push("caught[" + e + "]");
		}
	}

	console.log(out.join(" | "));
})();
