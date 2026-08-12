// structuredClone acceptance fixture. Written before implementation (TDD).
// Prints one line per check + a final
// "RESULT <passed>/<total>" the runner asserts.

const results = [];
function check(name, ok) {
	results.push([name, !!ok]);
}
function isDataCloneError(error) {
	return (
		error instanceof DOMException &&
		error instanceof Error &&
		error.name === "DataCloneError" &&
		error.code === 25
	);
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
	fnThrew = isDataCloneError(e);
}
check("function throws DataCloneError", fnThrew);

let symThrew = false;
try {
	structuredClone(Symbol("x"));
} catch (e) {
	symThrew = isDataCloneError(e);
}
check("symbol throws DataCloneError", symThrew);

let unsupportedThrew = false;
try {
	structuredClone(new WeakMap());
} catch (e) {
	unsupportedThrew = isDataCloneError(e);
}
check("unsupported object throws DataCloneError", unsupportedThrew);

const detachedBuffer = new ArrayBuffer(4);
detachedBuffer.transfer();
let detachedBufferThrew = false;
try {
	structuredClone(detachedBuffer);
} catch (e) {
	detachedBufferThrew = isDataCloneError(e);
}
check("detached ArrayBuffer throws DataCloneError", detachedBufferThrew);

const detachedView = new Uint8Array(4);
detachedView.buffer.transfer();
let detachedViewThrew = false;
try {
	structuredClone(detachedView);
} catch (e) {
	detachedViewThrew = isDataCloneError(e);
}
check("detached TypedArray throws DataCloneError", detachedViewThrew);

const resizableBuffer = new ArrayBuffer(8, { maxByteLength: 8 });
const outOfBoundsView = new Uint8Array(resizableBuffer, 4, 4);
resizableBuffer.resize(2);
let outOfBoundsViewThrew = false;
try {
	structuredClone(outOfBoundsView);
} catch (e) {
	outOfBoundsViewThrew = isDataCloneError(e);
}
check("out-of-bounds TypedArray throws DataCloneError", outOfBoundsViewThrew);

let missingThrew = false;
try {
	structuredClone();
} catch (e) {
	missingThrew = e instanceof TypeError;
}
check("missing argument remains TypeError", missingThrew);

const getterAbrupt = new RangeError("getter abrupt");
let getterAbruptPreserved = false;
try {
	structuredClone({
		get value() {
			throw getterAbrupt;
		},
	});
} catch (e) {
	getterAbruptPreserved = e === getterAbrupt;
}
check("getter abrupt completion is preserved", getterAbruptPreserved);

let getterCalls = 0;
const getterClone = structuredClone({
	get value() {
		getterCalls++;
		return { nested: 7 };
	},
});
check(
	"getter result is cloned once",
	getterCalls === 1 && getterClone.value.nested === 7,
);

const changedEnumerable = {};
Object.defineProperty(changedEnumerable, "first", {
	enumerable: true,
	get() {
		Object.defineProperty(changedEnumerable, "second", { enumerable: false });
		return 1;
	},
});
Object.defineProperty(changedEnumerable, "second", {
	configurable: true,
	enumerable: true,
	value: 2,
});
const changedEnumerableClone = structuredClone(changedEnumerable);
check(
	"snapshot key survives enumerability change",
	changedEnumerableClone.first === 1 && changedEnumerableClone.second === 2,
);

const transferredBuffer = new Uint8Array([4, 5, 6]).buffer;
const transferredBufferClone = structuredClone(transferredBuffer, {
	transfer: [transferredBuffer],
});
check(
	"ArrayBuffer transfer detaches source",
	transferredBuffer.byteLength === 0 &&
		transferredBufferClone.byteLength === 3 &&
		new Uint8Array(transferredBufferClone)[2] === 6,
);

const transferredViewBuffer = new ArrayBuffer(6);
const transferredView = new Uint16Array(transferredViewBuffer, 2, 2);
transferredView[0] = 0x1234;
const transferredViewClone = structuredClone(transferredView, {
	transfer: new Set([transferredViewBuffer]),
});
check(
	"TypedArray clone uses transferred backing buffer",
	transferredViewBuffer.byteLength === 0 &&
		transferredViewClone instanceof Uint16Array &&
		transferredViewClone.byteOffset === 2 &&
		transferredViewClone.length === 2 &&
		transferredViewClone[0] === 0x1234,
);

const unusedTransfer = new ArrayBuffer(2);
const unusedTransferClone = structuredClone(
	{ ok: true },
	{
		transfer: [unusedTransfer],
	},
);
check(
	"unreferenced transfer still detaches",
	unusedTransfer.byteLength === 0 && unusedTransferClone.ok,
);

const duplicateTransfer = new ArrayBuffer(2);
let duplicateTransferThrew = false;
try {
	structuredClone(null, { transfer: [duplicateTransfer, duplicateTransfer] });
} catch (error) {
	duplicateTransferThrew = isDataCloneError(error);
}
check(
	"duplicate transfer fails before detaching",
	duplicateTransferThrew && duplicateTransfer.byteLength === 2,
);

let passed = 0;
for (const [name, ok] of results) {
	if (ok) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
