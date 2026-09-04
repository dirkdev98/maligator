const allocatedBytes = globalThis.__mal_gc_allocated_bytes;
const collections = globalThis.__mal_gc_collections;
if (typeof allocatedBytes !== "function" || typeof collections !== "function") {
	console.log("absent");
} else {
	const collect = globalThis.__mal_collect_garbage;
	if (typeof collect !== "function") throw new Error("missing forced collection hook");
	const allocatedBefore = allocatedBytes();
	const collectionsBefore = collections();
	const values = Array.from({ length: 1_000 }, (_, index) => ({ index }));
	collect();
	console.log(
		JSON.stringify({
			allocatedBefore,
			allocatedAfter: allocatedBytes(),
			collectionsBefore,
			collectionsAfter: collections(),
			retained: values.length,
		}),
	);
}
