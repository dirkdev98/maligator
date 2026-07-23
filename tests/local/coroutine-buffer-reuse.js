const gc = globalThis.__mal_collect_garbage;
if (typeof gc !== "function") {
	throw new Error("coroutine-buffer-reuse requires MAL_HOST_GC=1");
}

function* inspect(p0, p1, p2, p3, p4, p5, p6) {
	yield [arguments.length, p0, p1, p2, p3, p4, p5, p6];
}

function check(values) {
	const iterator = inspect(...values);
	const first = iterator.next();
	if (first.done || first.value.length !== 8 || first.value[0] !== values.length) {
		throw new Error("frame shape");
	}
	for (let i = 0; i < 7; i++) {
		const expected = i < values.length ? values[i] : undefined;
		if (first.value[i + 1] !== expected) {
			throw new Error("stale slot " + i + " after " + values.length + " arguments");
		}
	}
	gc();
	const last = iterator.next();
	if (!last.done || last.value !== undefined) throw new Error("completion");
}

// Argument buffers request one size class in smaller/equal/larger order. The
// fixed register frame is poisoned first so omitted parameters also verify that
// release-cleared slots remain undefined when allocation skips the old prefix.
check(new Array(6).fill(null).map((_, index) => ({ poison: index })));
check(new Array(5).fill(null).map((_, index) => ({ smaller: index })));
check(new Array(5).fill(null).map((_, index) => ({ equal: index })));
check(new Array(7).fill(null).map((_, index) => ({ larger: index })));

console.log("coroutine-buffer-reuse PASS");
