// Targeted GC unit test: the RAW-table delete/clear paths under forced collection.
// Map/Set entry tables and object dictionary tables funnel deletes and clears
// through mal_table_delete / mal_table_clear, whose SATB shade sites are no-ops in
// this STW build. This asserts STW correctness: after deleting/clearing entries
// interleaved with forced (and, under MAL_GC_STRESS, per-safepoint) collections,
// the surviving entries are intact and nothing dangles (MAL_GC_VERIFY would abort
// on a reclaimed-but-referenced cell). A failed assertion throws; the final
// "gctable PASS N/N" line prints only on full success.

const gc = globalThis.__mal_collect_garbage;
if (typeof gc !== "function") {
	throw new Error("gctable requires MAL_HOST_GC=1 (gc hook absent)");
}

let passed = 0;
function ok(name, cond) {
	if (cond) {
		passed++;
		console.log("PASS " + name);
	} else {
		console.log("FAIL " + name);
		throw new Error("FAIL " + name);
	}
}

// Distinctive heap value per entry so a corrupted survivor is detectable.
function val(i) {
	return { id: i, big: new Array(16).fill(i) };
}
function intact(v, i) {
	return v !== undefined && v !== null && v.id === i && v.big[0] === i && v.big[15] === i;
}

// --- Object dictionary mode (>32 own props forces the dictionary table). ---
let dict = {};
for (let i = 0; i < 60; i++) {
	dict["k" + i] = val(i);
}
for (let i = 0; i < 60; i += 2) {
	delete dict["k" + i]; // drop evens, interleaving a collection every few deletes
	if (i % 10 === 0) gc();
}
gc();
let dictOk = true;
for (let i = 1; i < 60; i += 2) {
	if (!("k" + i in dict) || !intact(dict["k" + i], i)) {
		dictOk = false;
	}
}
for (let i = 0; i < 60; i += 2) {
	if ("k" + i in dict) {
		dictOk = false; // evens must be gone
	}
}
ok("dict-delete-survivors-intact", dictOk);
// Re-add after deletes, then collect: the reused table slots stay coherent.
for (let i = 0; i < 60; i += 2) {
	dict["k" + i] = val(i + 1000);
}
gc();
ok(
	"dict-readd-after-delete-intact",
	intact(dict.k0, 1000) && intact(dict.k58, 1058) && intact(dict.k59, 59),
);

// --- Shaped object delete (transitions the shape, not the dictionary path). ---
let shaped = { a: val(1), b: val(2), c: val(3), d: val(4) };
delete shaped.b;
delete shaped.d;
gc();
ok(
	"shaped-delete-survivors-intact",
	intact(shaped.a, 1) && intact(shaped.c, 3) && !("b" in shaped) && !("d" in shaped),
);

// --- Map delete + clear + reuse. ---
let m = new Map();
for (let i = 0; i < 50; i++) {
	m.set("e" + i, val(i));
}
let deleted = 0;
for (let i = 0; i < 50; i += 3) {
	m.delete("e" + i);
	deleted++;
	if (i % 9 === 0) gc();
}
gc();
let mapOk = m.size === 50 - deleted;
m.forEach((v, k) => {
	if (!intact(v, Number(k.slice(1)))) {
		mapOk = false;
	}
});
ok("map-delete-survivors-intact", mapOk);
m.clear();
gc();
ok("map-clear-empties", m.size === 0);
m.set("x", val(99));
m.set("y", val(100));
gc();
ok(
	"map-reuse-after-clear-intact",
	m.size === 2 && intact(m.get("x"), 99) && intact(m.get("y"), 100),
);

// --- Set delete + clear + reuse (object elements so the entries hold cells). ---
let s = new Set();
let elems = [];
for (let i = 0; i < 40; i++) {
	let e = val(i);
	elems.push(e);
	s.add(e);
}
for (let i = 0; i < 40; i += 2) {
	s.delete(elems[i]);
	if (i % 8 === 0) gc();
}
gc();
let setOk = s.size === 20;
for (let i = 1; i < 40; i += 2) {
	if (!s.has(elems[i]) || !intact(elems[i], i)) {
		setOk = false;
	}
}
ok("set-delete-survivors-intact", setOk);
s.clear();
gc();
ok("set-clear-empties", s.size === 0);

console.log("gctable PASS " + passed + "/" + passed);
