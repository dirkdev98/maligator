// Allocation-heavy workload — the axis where an allocation optimization could
// pay off. Short-lived plain objects and arrays are created inside the loop.
// With no GC the heap grows monotonically, so the count is kept to a few
// million small objects (well within the bump allocator's linear regime).

function makePoint(x, y) {
	return { x: x, y: y };
}

function dist2(a, b) {
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	return dx * dx + dy * dy;
}

let sum = 0;
const origin = { x: 0, y: 0 };
for (let i = 0; i < 1500000; i++) {
	const p = makePoint(i % 1000, (i * 7) % 1000);
	const q = makePoint((i * 3) % 1000, (i * 5) % 1000);
	sum = sum + dist2(p, q) + dist2(p, origin);
	if (sum > 1e15) {
		sum = sum % 1000000007;
	}
}
console.log(Math.round(sum % 1000000007));
