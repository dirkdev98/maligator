// GC leak-audit exerciser (T6.3). Touches every §A–D allocation category from
// docs/roadmaps/gc.md, dropping most allocations and keeping a sample. Run it with
// `npm run test:leak`, which expects zero leaks at shutdown. A non-zero count names
// the leaking category in the grouped backtrace.
//
// Coverage map (inventory row -> section):
//   A objects (shaped/dict/delete/freeze/symbol/accessor), arrays, strings   -> 1,2,3
//   C Map/Set entries, WeakMap/WeakSet, ArrayBuffer data, MalEnv closures,
//     bound args, generator/async-generator frame buffers                    -> 4,5,6,7
//   D Rust FFI handles (regexp matcher, Intl Collator/PluralRules)           -> 9
//   plus promises/reactions, Date/Error/BigInt/Symbol/Proxy                  -> 8,10
// Not covered here (needs a multi-file module): module-namespace exports[].

let keep = [];
function maybeKeep(i, v) {
	if (i % 97 === 0) keep.push(v);
}

// 1. objects: shaped + dictionary (>32 props) + delete + freeze + symbol + accessor
for (let i = 0; i < 3000; i++) {
	let shaped = { a: i, b: i + 1, c: "s" + i };
	let dict = {};
	for (let j = 0; j < 40; j++) dict["k" + j] = j;
	let del = { x: 1, y: 2, z: 3 };
	delete del.y;
	let sym = {};
	sym[Symbol("s")] = i;
	sym.n = i;
	let acc = {};
	Object.defineProperty(acc, "g", {
		get() {
			return i;
		},
		configurable: true,
	});
	let frozen = Object.freeze({ p: i, q: i });
	maybeKeep(i, [shaped, dict, del, sym, acc, frozen]);
}
// 2. arrays: dense, holes, big
for (let i = 0; i < 3000; i++) {
	let dense = [i, i + 1, i + 2, i + 3];
	let holes = [1, , 3, , 5];
	let big = [];
	for (let j = 0; j < 60; j++) big.push(j);
	maybeKeep(i, [dense, holes, big]);
}
// 3. strings: concat (owned), big (LOS), substring
for (let i = 0; i < 3000; i++) {
	let s = ("abc" + i + "def").repeat(3);
	let big = "z".repeat(9000); // > LOS threshold
	let sub = big.substring(10, 200);
	maybeKeep(i, [s, sub, big.length]);
}
// 4. Map/Set/WeakMap/WeakSet
for (let i = 0; i < 3000; i++) {
	let m = new Map();
	for (let j = 0; j < 8; j++) m.set("e" + j, j);
	let s = new Set([1, 2, 3, i]);
	let wm = new WeakMap();
	let k = {};
	wm.set(k, i);
	let ws = new WeakSet();
	ws.add({});
	maybeKeep(i, [m, s, wm]);
}
// 5. typed arrays / ArrayBuffer / DataView (incl large/LOS)
for (let i = 0; i < 2000; i++) {
	let ab = new ArrayBuffer(64);
	let u8 = new Uint8Array(ab);
	u8[0] = i & 0xff;
	let f64 = new Float64Array(16);
	f64[0] = i;
	let big = new ArrayBuffer(20000); // LOS
	let dv = new DataView(ab);
	dv.setInt32(0, i);
	maybeKeep(i, [u8, f64, dv]);
}
// 6. closures / bound functions
for (let i = 0; i < 3000; i++) {
	let base = i;
	let f = function () {
		return base + 1;
	};
	let b = f.bind(null);
	maybeKeep(i, [f, b]);
}
// 7a. sync generators (abandoned mid-iteration -> suspended frame buffers)
function* gen(n) {
	for (let j = 0; j < n; j++) yield j;
}
for (let i = 0; i < 2000; i++) {
	let g = gen(10);
	g.next();
	g.next();
	maybeKeep(i, g);
	let unopened = gen(2);
	if (i & 1) unopened.return(i);
	else {
		try {
			unopened.throw(i);
		} catch {}
	}
}
// 7b. async generators + pending async functions (same suspendable-frame machinery)
async function* agen(n) {
	for (let j = 0; j < n; j++) yield j;
}
let pendingForever = new Promise(() => {});
async function stalled() {
	await pendingForever; // never settles -> frame stays suspended at exit
	return 1;
}
async function* blockedAgen() {
	await pendingForever;
	yield 1;
}
for (let i = 0; i < 1500; i++) {
	let ag = agen(5);
	ag.next();
	let blocked = blockedAgen();
	blocked.next();
	blocked.next(); // leave one malloc-owned request queued when abandoned
	let st = stalled();
	maybeKeep(i, [ag, blocked, st]);
}
// 8. promises + reactions
for (let i = 0; i < 2000; i++) {
	let p = Promise.resolve(i)
		.then((x) => x + 1)
		.then((x) => x * 2);
	let r = Promise.reject("e").catch(() => i);
	maybeKeep(i, [p, r]);
}
// 9. regexp (Rust matcher) + Intl (Rust handles)
for (let i = 0; i < 1500; i++) {
	let re = new RegExp("a(b+)c" + (i % 10), "g");
	re.test("abbbc" + (i % 10));
	let col = new Intl.Collator("en");
	col.compare("a", "b");
	let pr = new Intl.PluralRules("en");
	pr.select(i);
	maybeKeep(i, [re, col, pr]);
}
// 10. Date / Error / BigInt / Symbol / Proxy
for (let i = 0; i < 2000; i++) {
	let d = new Date(i * 1000);
	let e = new Error("boom " + i);
	let bi = BigInt(i) * 1000000000000000000n;
	let sy = Symbol("sym" + i);
	let px = new Proxy(
		{ v: i },
		{
			get(t, k) {
				return t[k];
			},
		},
	);
	maybeKeep(i, [d, e.stack.length, bi, sy, px.v]);
}

let n = 0;
for (const e of keep) n++;
console.log("audit-ok kept=" + n);
