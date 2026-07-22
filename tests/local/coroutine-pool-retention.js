const gc = globalThis.__mal_collect_garbage;
if (typeof gc !== "function") {
	throw new Error("coroutine-pool-retention requires MAL_HOST_GC=1");
}

function* smallFrame(value) {
	yield value + 1;
}

function abandonBatch(count) {
	for (let i = 0; i < count; i++) smallFrame(i).next();
}

// The first batch remains suspended until collection finalizes it. The second
// batch requests the same capacity class and should reuse thousands of buffers.
abandonBatch(5000);
gc();
gc();
abandonBatch(5000);

console.log("coroutine-pool-retention PASS");
