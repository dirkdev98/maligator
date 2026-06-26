// Generational-GC correctness exerciser (item 2). Built with MAL_GC_GENERATIONAL=1
// and run under MAL_GC_STRESS + MAL_GC_VERIFY, this drives every kind of
// old->young pointer edge: an object that survives a collection (becoming "old" /
// sticky-BLACK) is then mutated to point at a freshly-allocated ("young") object.
// A sound write barrier records the edge so the minor collection traces the old
// cell and keeps the young target alive; a missed edge frees the young target and
// either the generational verifier aborts or the assertion below reads poison.
//
// Pure-JS, no host harness assumptions beyond the two env-gated hooks the runtime
// installs under MAL_HOST_GC. Throws on any mismatch; prints "gengctest PASS N/N".

const gc = globalThis.__mal_collect_garbage;
const liveBytes = globalThis.__mal_gc_live_bytes;
if (typeof gc !== "function") {
	throw new Error("gengctest must run with MAL_HOST_GC=1 (gc hook missing)");
}

let passed = 0;
let total = 0;
function check(name, cond) {
	total++;
	if (!cond) {
		throw new Error(`gengctest FAIL: ${name}`);
	}
	passed++;
}

// Promote `holder` to old: it survives a collection. Then write a young object
// into it and collect again — a minor collect must keep the young value via the
// remembered set. We read the value back after the collect to confirm liveness.

// 1. Object property old->young.
(function objectProperty() {
	const holder = { tag: "holder" };
	gc(); // holder survives -> old
	holder.child = { v: 12345 }; // old.field = young
	gc(); // minor: must trace holder via remembered set, keep child
	gc();
	check("object-property old->young survives", holder.child.v === 12345);
})();

// 2. Array element old->young.
(function arrayElement() {
	const arr = [0, 0, 0];
	gc(); // arr -> old
	arr[1] = { v: 222 }; // old array element = young
	arr.push({ v: 333 }); // append (grows) = young
	gc();
	gc();
	check("array element old->young survives", arr[1].v === 222 && arr[3].v === 333);
})();

// 3. Map value + key old->young.
(function mapEntry() {
	const m = new Map();
	const oldKey = { k: "stable" };
	m.set(oldKey, 1);
	gc(); // m + oldKey -> old
	const youngKey = { k: "fresh" };
	m.set(youngKey, { v: 444 }); // old map gains young key + young value
	m.set(oldKey, { v: 555 }); // old map, young value at existing (old) key
	gc();
	gc();
	check("map young value at young key", m.get(youngKey).v === 444);
	check("map young value at old key", m.get(oldKey).v === 555);
})();

// 4. Prototype old->young (Object.setPrototypeOf after promotion).
(function prototypeEdge() {
	const obj = {};
	gc(); // obj -> old
	const proto = { greet() { return "hi"; }, marker: 999 };
	Object.setPrototypeOf(obj, proto); // old.[[Prototype]] = young
	gc();
	gc();
	check("prototype old->young survives", obj.marker === 999 && obj.greet() === "hi");
})();

// 5. Closure-captured binding old->young (env slot store).
(function closureCapture() {
	let captured = { v: 1 };
	const setIt = (x) => {
		captured = x;
	};
	const getIt = () => captured;
	gc(); // the closures + their shared env -> old
	setIt({ v: 6789 }); // env slot = young
	gc();
	gc();
	check("captured env slot old->young survives", getIt().v === 6789);
})();

// 6. Promise reaction + result old->young.
function promiseEdge() {
	let resolveFn;
	const p = new Promise((res) => {
		resolveFn = res;
	});
	let observed = 0;
	p.then((value) => {
		observed = value.v;
	});
	gc(); // promise (pending) + its reaction -> old
	resolveFn({ v: 7777 }); // old promise's result = young; reaction fires async
	gc();
	// Resolve after a microtask tick so the reaction has fired.
	return Promise.resolve().then(() => {
		gc();
		check("promise young result delivered", observed === 7777);
	});
}

// 7. Generator frame old->young (yields across collections, holding young locals).
function* counter() {
	let acc = { sum: 0 };
	for (let i = 1; i <= 4; i++) {
		acc = { sum: acc.sum + i }; // a fresh young object each resume, held in the frame
		yield acc.sum;
	}
	return acc.sum;
}
function generatorEdge() {
	const g = counter();
	const seen = [];
	seen.push(g.next().value);
	gc(); // suspended generator -> old, its frame holds `acc` (young)
	seen.push(g.next().value);
	gc();
	seen.push(g.next().value);
	gc();
	seen.push(g.next().value);
	gc();
	const done = g.next();
	check("generator frame old->young across yields", seen.join(",") === "1,3,6,10" && done.value === 10);
}
generatorEdge();

// 8. Churn: many short-lived young objects between two long-lived old roots, to
//    drive repeated minor collections and free-list reuse without touching the old
//    roots' recorded edges.
(function churn() {
	const roots = [{ id: "a" }, { id: "b" }];
	gc(); // roots -> old
	let sink = 0;
	for (let i = 0; i < 5000; i++) {
		const tmp = { i, pad: [i, i + 1, i + 2] };
		sink += tmp.i;
		if (i % 500 === 0) {
			roots[0].latest = tmp; // periodically pin a young object into an old root
			gc();
		}
	}
	check("churn old roots intact", roots[0].id === "a" && roots[1].id === "b");
	check("churn pinned young survived", roots[0].latest.i === 4500);
	check("churn arithmetic", sink === (4999 * 5000) / 2);
})();

const promiseTest = promiseEdge();
Promise.resolve(promiseTest).then(() => {
	if (typeof liveBytes === "function") {
		// Sanity: a final collection leaves a finite live set.
		gc();
		check("live bytes finite after final gc", liveBytes() >= 0);
	}
	globalThis.console.log(`gengctest PASS ${passed}/${total}`);
});
