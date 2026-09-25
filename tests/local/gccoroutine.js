// Targeted GC unit tests: coroutine-frame tracing (regression coverage for the
// 2026-07-10 fixes). A suspended generator / async function / async generator
// keeps its live locals in a heap-allocated frame the collector must trace; two
// distinct defects were fixed:
//   - uninit-frame:  a generator created but never resumed left `frame` garbage,
//                    so tracing it read uninitialized memory;
//   - COMPLETED:     tracing a run-to-completion coroutine dereferenced its freed
//                    register buffer (the tracer must skip COMPLETED coroutines);
// gccoroutine-eval.js separately checks frame tracing after runtime compilation.
// Plus the positive contract: a heap object held in a coroutine local across a
// forced GC survives intact on resume. Driven by MAL_HOST_GC on the HOST event
// loop (async coroutines suspend across a real turn boundary). A failed assertion
// throws; the final "gccoroutine PASS N/N" prints only on full success.

const gc = globalThis.__mal_collect_garbage;
if (typeof gc !== "function") {
	throw new Error("gccoroutine requires MAL_HOST_GC=1 (gc hook absent)");
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

function* holder(tag) {
	// A live heap object in a generator local across the yield: the collector must
	// trace it through the suspended frame or it is freed and the resume reads junk.
	let obj = { tag, data: new Array(500).fill(tag.length) };
	yield 1;
	yield obj.tag; // reachable only through the suspended frame while suspended
}

function* counter(n) {
	for (let i = 0; i < n; i++) {
		yield i;
	}
	return "done";
}

// Async coroutines suspend on this gate, which is resolved a turn later so a gc()
// runs while their frames are suspended.
let resolveAsyncGate, resolveAgenGate;
const asyncGate = new Promise((r) => (resolveAsyncGate = r));
const agenGate = new Promise((r) => (resolveAgenGate = r));

async function asyncHolder(gate) {
	let obj = { tag: "held-in-async", data: new Array(500).fill(2) };
	await gate; // suspend; obj lives only in the suspended async frame
	return obj.tag;
}

async function* agenHolder(gate) {
	let obj = { tag: "held-in-agen", data: new Array(300).fill(3) };
	await gate; // suspend the async generator mid-body
	yield obj.tag;
}

let asyncResult, agenResult;

const turns = [
	// Turn 0: all synchronous coroutine cases, plus kick off the async coroutines
	// so they suspend on their gates before turn 1's gc().
	function synchronous() {
		// uninit-frame: create but never resume, then collect (traces an un-started
		// frame), then resume — must still produce the first value.
		let ug = holder("uninit");
		gc();
		ok("uninit-generator-resumes", ug.next().value === 1);
		ok("uninit-generator-frame-object-survives", ug.next().value === "uninit");

		// COMPLETED-frame: run to completion, then collect (traces a COMPLETED
		// coroutine — must not touch its freed register buffer), then re-poll.
		let cg = counter(2);
		ok("completed-gen-v0", cg.next().value === 0);
		ok("completed-gen-v1", cg.next().value === 1);
		let last = cg.next();
		ok("completed-gen-returns", last.done === true && last.value === "done");
		gc();
		ok("completed-gen-stays-done", cg.next().done === true);

		// Suspended-across-GC: object held in the frame survives a forced collection.
		let sg = holder("suspended");
		sg.next(); // suspend at first yield
		gc();
		ok("suspended-gen-frame-object-survives", sg.next().value === "suspended");

		// Kick off async coroutines; they run to their `await gate` and suspend.
		asyncHolder(asyncGate).then((v) => (asyncResult = v));
		agenHolder(agenGate)
			.next()
			.then((r) => (agenResult = r.value));
	},

	// Turn 1: collect while the async frames are suspended (traces them), then open
	// the gates so they resume; the resumptions drain in this turn's checkpoint.
	function collectThenResume() {
		gc();
		resolveAsyncGate(0);
		resolveAgenGate(0);
	},

	// Turn 2: the resumed coroutines produced their frame-held objects intact.
	function verifyAsync() {
		ok("suspended-async-frame-object-survives", asyncResult === "held-in-async");
		ok("suspended-agen-frame-object-survives", agenResult === "held-in-agen");
	},
];

let i = 0;
function step() {
	if (i < turns.length) {
		turns[i++]();
		setTimeout(step, 0);
	} else {
		console.log("gccoroutine PASS " + passed + "/" + passed);
	}
}
setTimeout(step, 0);
