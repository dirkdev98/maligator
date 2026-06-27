// GC profile: desktop / long-running background process.
//
// Characteristics: long-lived, steady-state. A bounded long-lived working set (an
// LRU-ish cache) persists for the whole run, while each "tick" of the event loop
// produces a burst of short-lived garbage (event objects, per-tick closures) that
// dies almost immediately. The young/old ratio is high and the old set is roughly
// STABLE — exactly the shape a generational collector is built for.
//
// What good GC behaviour looks like here: small, predictable MINOR pauses (scan
// roots + the small remembered set, not the whole stable old set), with MAJOR
// collections rare (the old cache barely changes, so re-marking it every few
// collections is wasted work). Tuning levers: the minor trigger (young budget)
// and the major cadence (MAL_GC_MAJOR_EVERY).

const CACHE_LIMIT = 2000;
const cache = {}; // long-lived: ~CACHE_LIMIT retained entries
let cacheKeys = [];

function remember(key, value) {
	if (cache[key] === undefined) {
		cacheKeys.push(key);
		if (cacheKeys.length > CACHE_LIMIT) {
			const evict = cacheKeys.shift();
			cache[evict] = undefined;
		}
	}
	cache[key] = value;
}

function handleTick(t) {
	// Short-lived per-tick garbage: an event object + a transient working array.
	const event = { id: t, type: t % 5, payload: { a: t & 7, b: (t * 3) & 15 } };
	const scratch = [];
	for (let i = 0; i < 16; i++) {
		scratch.push({ i: i, v: (t + i) % 97 });
	}
	let local = 0;
	for (let i = 0; i < scratch.length; i++) {
		local += scratch[i].v + event.payload.a;
	}
	// Occasionally promote something into the long-lived cache.
	if (t % 8 === 0) {
		remember("k" + (t % (CACHE_LIMIT * 2)), { sum: local, type: event.type });
	}
	return local;
}

let checksum = 0;
for (let t = 0; t < 600000; t++) {
	checksum = (checksum + handleTick(t)) % 1000000007;
}
console.log(checksum);
