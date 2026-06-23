// Array iteration via the iterator protocol (for-of, spread, destructuring, keys/
// values/entries) — exercises the dense array_advance fast path + its fallbacks.
(function () {
	const out = [];
	const log = (l, v) => out.push(l + ":" + v);

	// for-of values over a dense array.
	let s = ""; for (const x of [1, 2, 3]) s += x; log("vals", s);

	// Holes yield undefined (Get, not skip).
	s = ""; for (const x of [1, , 3]) s += x + ","; log("holes", s); // 1,undefined,3,

	// length-extended (trailing holes) yield undefined.
	const ext = [1, 2]; ext.length = 4;
	s = ""; for (const x of ext) s += x + ","; log("ext", s); // 1,2,undefined,undefined,

	// keys / values / entries.
	log("keys", [...["a", "b", "c"].keys()].join(","));        // 0,1,2
	log("values", [...["a", "b"].values()].join(","));          // a,b
	log("entries", [...[10, 20].entries()].map(e => e[0] + "=" + e[1]).join(",")); // 0=10,1=20

	// break / continue.
	s = ""; for (const x of [1, 2, 3, 4, 5]) { if (x === 4) break; if (x % 2 === 0) continue; s += x; } log("brk", s); // 13

	// spread + destructuring.
	log("spread", [...[1, 2], ...[3, 4]].join(","));
	const [a, , c] = [7, 8, 9]; log("destr", a + "," + c);

	// nested for-of.
	s = ""; for (const r of [[1, 2], [3]]) for (const x of r) s += x; log("nested", s); // 123

	// mutation during iteration (push grows; visited because length is live).
	const m = [1, 2]; let n = 0; let count = 0;
	for (const x of m) { n += x; if (count++ < 2 && x < 3) m.push(x + 10); if (count > 10) break; }
	log("mutate", n); // 1+2+11+12 = 26

	// non-array iterables still work (fall back paths).
	s = ""; for (const x of new Set([1, 2, 2, 3])) s += x; log("set", s); // 123
	s = ""; for (const [k, v] of new Map([["a", 1], ["b", 2]])) s += k + v; log("map", s); // a1b2
	s = ""; for (const ch of "hi") s += ch + "."; log("str", s); // h.i.
	function* g() { yield 1; yield 2; }
	s = ""; for (const x of g()) s += x; log("gen", s); // 12

	// Array iterator .call on an array-like (target is NOT an array → fallback).
	const like = { length: 3, 0: "x", 1: "y", 2: "z" };
	log("arraylike", [...Array.prototype.values.call(like)].join(",")); // x,y,z

	// Subclass array.
	class MyArr extends Array {}
	const sub = MyArr.from([5, 6, 7]);
	s = ""; for (const x of sub) s += x; log("subclass", s); // 567

	// Patched Array iterator next → must use the patched one (fallback).
	const orig = Array.prototype[Symbol.iterator];
	Array.prototype[Symbol.iterator] = function () {
		let i = 0; const self = this;
		return { next: () => i < self.length ? { value: self[i++] * 100, done: false } : { value: undefined, done: true } };
	};
	s = ""; for (const x of [1, 2]) s += x + ","; log("patched", s); // 100,200,
	Array.prototype[Symbol.iterator] = orig;

	console.log(out.join(" | "));
})();
