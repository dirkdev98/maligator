// Exercises the dense array element vector across the tricky paths: reads/writes,
// holes, enumeration order, freeze/seal, deopt triggers, length, mixed keys.
(function () {
	const out = [];
	const log = (label, value) => out.push(label + ":" + value);

	// Basic literal + index access.
	const a = [10, 20, 30];
	log("idx", a[0] + "," + a[1] + "," + a[2]);
	a[1] = 99;
	log("set", a[1]);
	log("len", a.length);

	// push / pop / length growth + shrink.
	a.push(40, 50);
	log("push", a.join(","));
	log("pop", a.pop() + "/" + a.length);

	// Contiguous fill loop (the dense fast path).
	const b = [];
	for (let i = 0; i < 6; i++) b[i] = i * i;
	log("fill", b.join(","));

	// Small gap → holes inside the dense region.
	const c = [1, 2];
	c[5] = 6;
	log("gap", c.length + "/" + c.join(",") + "/" + (3 in c));

	// delete makes a hole; HasProperty reflects it.
	const d = [1, 2, 3];
	delete d[1];
	log("del", (1 in d) + "/" + d.length + "/" + d[1]);

	// Enumeration order: integer indices ascending, THEN string keys.
	const e = [11, 22, 33];
	e.foo = "x";
	e.bar = "y";
	log("keys", Object.keys(e).join(","));
	log("vals", Object.values(e).join(","));
	const forin = [];
	for (const k in e) forin.push(k);
	log("forin", forin.join(","));

	// Sparse / hole enumeration skips holes.
	const s = [];
	s[0] = "a";
	s[3] = "b";
	log("sparsekeys", Object.keys(s).join(","));

	// JSON: holes serialize as null.
	log("json", JSON.stringify([1, , 3]));
	log("jsonobj", JSON.stringify({ a: [1, 2], b: 3 }));

	// spread + destructuring (iterator protocol over dense).
	const sp = [...[1, 2, 3], 4];
	log("spread", sp.join(","));
	const [x, , z] = [7, 8, 9];
	log("destr", x + "," + z);

	// map / filter / reduce build dense result arrays.
	log("map", [1, 2, 3].map(n => n * 2).join(","));
	log("filter", [1, 2, 3, 4].filter(n => n % 2 === 0).join(","));

	// Object.assign from an array source (own enumerable indices + strings).
	const tgt = Object.assign({}, [100, 200]);
	log("assign", tgt[0] + "," + tgt[1]);

	// freeze: deopts, then elements become non-writable/non-configurable.
	const f = [1, 2, 3];
	Object.freeze(f);
	try { f[0] = 999; } catch (_) {} // ignored / throws (frozen)
	log("freeze", f[0] + "/" + Object.isFrozen(f));
	log("notfrozen", Object.isFrozen([1, 2, 3]));

	// seal.
	const g = [1, 2];
	Object.seal(g);
	log("sealed", Object.isSealed(g) + "/" + Object.isSealed([1]));

	// defineProperty with non-default attrs → deopt, value still readable.
	const h = [1, 2, 3];
	Object.defineProperty(h, "1", { value: 42, enumerable: false });
	log("defprop", h[1] + "/" + Object.keys(h).join(","));

	// Far-sparse write → deopt to table; still correct.
	const big = [1, 2, 3];
	big[5000] = "far";
	log("farsparse", big[0] + "/" + big[5000] + "/" + big.length);

	// length truncation drops elements.
	const t = [1, 2, 3, 4, 5];
	t.length = 2;
	log("trunc", t.join(",") + "/" + (3 in t));

	// length extension creates holes.
	const u = [1, 2];
	u.length = 4;
	log("extend", u.length + "/" + (2 in u));

	// preventExtensions: can't add a new index, can overwrite existing.
	const p = [1, 2];
	Object.preventExtensions(p);
	try { p[0] = 9; } catch (_) {}
	try { p[5] = 6; } catch (_) {} // ignored (no new index on non-extensible)
	log("prevext", p[0] + "/" + (5 in p));

	// includes / indexOf over dense.
	log("incl", [1, 2, 3].includes(2) + "/" + [1, 2, 3].indexOf(3));

	// nested arrays + length after splice.
	const n = [1, 2, 3, 4, 5];
	const removed = n.splice(1, 2, "a", "b", "c");
	log("splice", n.join(",") + "/" + removed.join(","));

	console.log(out.join(" | "));
})();
