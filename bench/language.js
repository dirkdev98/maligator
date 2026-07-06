// Wide-coverage language benchmark: one program folding the former micro suite
// (loops/control-flow, object property churn, dense arrays, allocation, Array +
// Math intrinsics, for-of + try/catch) so a single wall-time number tracks broad
// codegen health against Node/V8. Bounded, deterministic; prints one checksum.

// --- loops + integer/float arithmetic + nested control flow -----------------
function countPrimes(limit) {
	let count = 0;
	let checksum = 0;
	for (let n = 2; n < limit; n++) {
		let isPrime = true;
		for (let d = 2; d * d <= n; d++) {
			if (n % d === 0) {
				isPrime = false;
				break;
			}
		}
		if (isPrime) {
			count = count + 1;
			checksum = (checksum + n) % 1000000007;
		}
	}
	return count + checksum;
}

function collatzSteps(start) {
	let steps = 0;
	let n = start;
	while (n > 1) {
		n = (n & 1) === 0 ? n / 2 : 3 * n + 1;
		steps = steps + 1;
	}
	return steps;
}

function loops() {
	let total = 0;
	for (let iter = 0; iter < 4; iter++) {
		total = total + countPrimes(20000);
		for (let n = 1; n < 20000; n++) total = (total + collatzSteps(n)) % 2000000011;
	}
	return total;
}

// --- object property load/store in a hot loop -------------------------------
function objects() {
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
	for (let step = 0; step < 500; step++) {
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
	return Math.round(checksum);
}

// --- dense array element access ---------------------------------------------
function arrays() {
	let acc = 0;
	for (let iter = 0; iter < 800; iter++) {
		const a = [];
		for (let i = 0; i < 1000; i++) a[i] = i;
		let s = 0;
		for (let i = 0; i < 1000; i++) s += a[i];
		for (let i = 0; i < 1000; i++) s += a[(i * 7) % 1000];
		acc += s;
	}
	return acc;
}

// --- allocation-heavy (short-lived plain objects) ---------------------------
function alloc() {
	const makePoint = (x, y) => ({ x, y });
	const dist2 = (a, b) => (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y);
	let sum = 0;
	const origin = { x: 0, y: 0 };
	for (let i = 0; i < 600000; i++) {
		const p = makePoint(i % 1000, (i * 7) % 1000);
		const q = makePoint((i * 3) % 1000, (i * 5) % 1000);
		sum = sum + dist2(p, q) + dist2(p, origin);
		if (sum > 1e15) sum = sum % 1000000007;
	}
	return Math.round(sum % 1000000007);
}

// --- Array iteration methods + Math intrinsics + native callback dispatch ----
function intrinsics() {
	const N = 4000;
	const data = [];
	for (let i = 0; i < N; i++) data.push(((i * 2654435761) % 10007) / 10007);
	let acc = 0;
	for (let iter = 0; iter < 200; iter++) {
		const s = data.reduce(
			(sum, v) => sum + Math.sqrt(v) * Math.sin(v) + Math.abs(v - 0.5),
			0,
		);
		let hits = 0;
		data.forEach((v) => {
			if (v > 0.5) hits = hits + Math.floor(v * 100);
		});
		acc = acc + s + hits;
	}
	return Math.round(acc);
}

// --- for-of iteration + try/catch in a hot function -------------------------
function control() {
	function classify(values) {
		let sum = 0;
		let errors = 0;
		for (const v of values) {
			try {
				if (v % 7 === 0) throw "div7";
				sum = sum + (v % 100);
			} catch (e) {
				errors = errors + 1;
			}
		}
		return sum + errors * 1000;
	}
	const data = [];
	for (let i = 0; i < 2000; i++) data.push(i * 31 + 1);
	let acc = 0;
	for (let iter = 0; iter < 1500; iter++) acc = (acc + classify(data)) % 1000000007;
	return acc;
}

const checksum =
	(loops() % 1000000007) +
	objects() +
	(arrays() % 1000000007) +
	alloc() +
	intrinsics() +
	control();
console.log(checksum);
