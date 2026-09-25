// Eval grows the function table while a generator caches its current function.
// Tracing must resolve that function again after the table moves.
const gc = globalThis.__mal_collect_garbage;
if (typeof gc !== "function") {
	throw new Error("gccoroutine-eval requires MAL_HOST_GC=1 (gc hook absent)");
}

function* holder() {
	const object = { tag: "evalsplice", data: new Array(16).fill(7) };
	yield 1;
	return object;
}

const generator = holder();
if (generator.next().value !== 1) throw new Error("generator did not suspend");
gc();
const spliced = eval("(function spliced_fn() { return 40 + 2; })");
if (spliced() !== 42) throw new Error("eval-splice new definition failed");
// This forced collection retains the regression boundary even when automatic
// compiler stress uses a coarser interval than the ordinary coroutine fixture.
gc();
const result = generator.next();
if (
	!result.done ||
	result.value.tag !== "evalsplice" ||
	result.value.data[0] !== 7 ||
	result.value.data[15] !== 7
) {
	throw new Error("suspended generator did not survive eval splice");
}
console.log("gccoroutine-eval PASS 3/3");
