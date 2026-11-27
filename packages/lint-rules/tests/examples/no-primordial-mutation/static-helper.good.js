// A function of your own, exported from a module in a larger program, leaves Math alone.
function clamp(value, low, high) {
	return Math.min(Math.max(value, low), high);
}

console.log(clamp(12, 0, 10), clamp(-3, 0, 10));
