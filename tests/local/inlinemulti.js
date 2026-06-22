// Multi-block inlining: clamp/sign/classify/sumTo are branching, multi-return
// LOCAL functions (lexically bound, so the inliner resolves the callee and splices
// them block-wise). Wrapped in an IIFE so they are not reassignable globals.
// Results must match Node exactly.
(function () {
	function clamp(x, lo, hi) {
		if (x < lo) return lo;
		if (x > hi) return hi;
		return x;
	}

	function sign(x) {
		if (x > 0) return 1;
		if (x < 0) return -1;
		return 0;
	}

	function classify(n) {
		let label;
		if (n % 2 === 0) {
			label = n === 0 ? "zero-even" : "even";
		} else {
			label = "odd";
		}
		return label + ":" + sign(n);
	}

	// A loop inside the inlined body (multiple blocks + back-edge).
	function sumTo(n) {
		let total = 0;
		for (let i = 1; i <= n; i++) {
			total += i;
		}
		return total;
	}

	const out = [];
	for (let i = -3; i <= 12; i++) {
		out.push(clamp(i, 0, 10) + "/" + sign(i) + "/" + classify(i) + "/" + sumTo(i));
	}
	console.log(out.join(" | "));
})();
