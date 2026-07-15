// structuredClone acceptance fixture. Run via the generic
// webtest runner: `node scripts/webtest.ts tests/local/structured_clone.js`.
// Written before implementation (TDD). Prints one line per check + a final
// "RESULT <passed>/<total>" the runner asserts.

const results = [];
function check(name, ok) {
	results.push([name, !!ok]);
}

// --- primitives pass through ---
check("num", structuredClone(42) === 42);
check("str", structuredClone("hi") === "hi");
check("bool", structuredClone(true) === true);
check("null", structuredClone(null) === null);
check("undefined", structuredClone(undefined) === undefined);
check("bigint", structuredClone(10n) === 10n);

// --- plain object: deep, independent ---
const o = { a: 1, b: { c: 2 } };
const co = structuredClone(o);
check("obj-not-same-ref", co !== o);
check("obj-shallow-val", co.a === 1);
check("obj-nested-cloned", co.b !== o.b && co.b.c === 2);
co.b.c = 99;
check("obj-independent", o.b.c === 2);

// --- array: deep ---
const a = [1, [2, 3]];
const ca = structuredClone(a);
check("arr-not-same-ref", ca !== a);
check("arr-nested-cloned", ca[1] !== a[1] && ca[1][1] === 3);
check("arr-length", ca.length === 2);

// --- Date ---
const d = new Date(1000);
const cd = structuredClone(d);
check("date-clone", cd !== d && cd instanceof Date && cd.getTime() === 1000);

// --- Map ---
const m = new Map([
	["k", "v"],
	[1, 2],
]);
const cm = structuredClone(m);
check(
	"map-clone",
	cm !== m &&
		cm instanceof Map &&
		cm.size === 2 &&
		cm.get("k") === "v" &&
		cm.get(1) === 2,
);

// --- Set ---
const s = new Set([1, 2, 3]);
const cs = structuredClone(s);
check("set-clone", cs !== s && cs instanceof Set && cs.size === 3 && cs.has(2));

// --- TypedArray ---
const u = new Uint8Array([1, 2, 3]);
const cu = structuredClone(u);
check("u8-clone", cu !== u && cu instanceof Uint8Array && cu.length === 3 && cu[0] === 1);
cu[0] = 99;
check("u8-independent", u[0] === 1);

// --- ArrayBuffer ---
const buf = new Uint8Array([9, 8, 7]).buffer;
const cbuf = structuredClone(buf);
check(
	"ab-clone",
	cbuf !== buf && cbuf instanceof ArrayBuffer && new Uint8Array(cbuf)[0] === 9,
);

// --- circular reference ---
const circ = { name: "x" };
circ.self = circ;
const cc = structuredClone(circ);
check("circular", cc !== circ && cc.self === cc && cc.name === "x");

// --- shared reference preserved within the clone ---
const shared = { v: 1 };
const graph = { a: shared, b: shared };
const cg = structuredClone(graph);
check("shared-ref", cg.a === cg.b && cg.a !== shared && cg.a.v === 1);

// --- uncloneable throws ---
let fnThrew = false;
try {
	structuredClone(() => {});
} catch (e) {
	fnThrew = true;
}
check("function-throws", fnThrew);

let symThrew = false;
try {
	structuredClone(Symbol("x"));
} catch (e) {
	symThrew = true;
}
check("symbol-throws", symThrew);

let passed = 0;
for (const [name, ok] of results) {
	if (ok) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
