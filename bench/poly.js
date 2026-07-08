// Polymorphic property-access micro-benchmark. One access site (`o.x`) is driven
// over arrays whose elements have 1, 2, or 6 distinct shapes, so the ratio of the
// poly/mega runs to the monomorphic run isolates the inline cache's polymorphism
// penalty (not general engine speed). A monomorphic engine cache thrashes at the
// 2-/6-shape sites (miss -> re-resolve every access); a tiered cache should stay
// close to the mono baseline. Bounded, deterministic; prints one JSON line.

function sumX(arr, iters) {
	let s = 0;
	const n = arr.length; // hoisted so the `.x` site is what the poly/mono ratio isolates
	for (let it = 0; it < iters; it++) {
		for (let i = 0; i < n; i++) {
			s = s + arr[i].x; // <- the access site under test
		}
	}
	return s;
}

// All variants put `.x` at a DIFFERENT slot across shapes (leading keys differ),
// so a monomorphic slot cache cannot be reused across them.
function build(n, shapes) {
	const a = [];
	for (let i = 0; i < n; i++) {
		a.push(shapes[i % shapes.length](i));
	}
	return a;
}

const MONO = [(i) => ({ x: i, y: i })];
const POLY2 = [(i) => ({ x: i, y: i }), (i) => ({ a: i, b: i, x: i })];
const POLY6 = [
	(i) => ({ x: i }),
	(i) => ({ a: i, x: i }),
	(i) => ({ a: i, b: i, x: i }),
	(i) => ({ p: i, q: i, r: i, x: i }),
	(i) => ({ m: i, x: i, y: i }),
	(i) => ({ b: i, c: i, d: i, e: i, x: i }),
];

const N = 2000;
const ITERS = 20000;
const mono = build(N, MONO);
const poly2 = build(N, POLY2);
const poly6 = build(N, POLY6);

function time(f) {
	const start = Date.now();
	const r = f();
	return { ms: Date.now() - start, r };
}

// Warm up (lets V8 tier up; harmless for the AOT engine).
sumX(mono, 200);
sumX(poly2, 200);
sumX(poly6, 200);

const m = time(() => sumX(mono, ITERS)).ms;
const p2 = time(() => sumX(poly2, ITERS)).ms;
const p6 = time(() => sumX(poly6, ITERS)).ms;

console.log(
	JSON.stringify({
		mono: m,
		poly2: p2,
		poly6: p6,
		"poly2/mono": +(p2 / m).toFixed(2),
		"poly6/mono": +(p6 / m).toFixed(2),
	}),
);
