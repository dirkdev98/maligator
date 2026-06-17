// Plain JavaScript objects + property access in a hot loop. Bounded memory:
// the object set is allocated once, then mutated in place across many steps.
// Exercises property load/store, array element access, float math, and
// data-dependent branching (the chokepoint that property-key interning and
// the O(1) bump allocator targeted).

const N = 3000;
const particles = [];
for (let i = 0; i < N; i++) {
	particles.push({
		x: i * 0.5,
		y: -i * 0.25,
		vx: (i % 13) - 6,
		vy: (i % 7) - 3,
		mass: (i % 9) + 1,
	});
}

let checksum = 0;
for (let step = 0; step < 1500; step++) {
	for (let i = 0; i < N; i++) {
		const p = particles[i];
		p.vy = p.vy + 0.01 * p.mass;
		p.x = p.x + p.vx;
		p.y = p.y + p.vy;
		if (p.y > 1000) {
			p.y = 0;
			p.vy = -p.vy;
		}
		if (p.x > 5000) {
			p.x = 0;
			p.vx = -p.vx;
		}
		checksum = checksum + (p.x - p.y);
	}
}
console.log(Math.round(checksum));
