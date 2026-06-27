// GC profile: web server / request-response.
//
// Characteristics: a stream of independent requests, each allocating a BURST of
// request-scoped objects (parsed params, intermediate collections, a built
// response) that all die when the request completes. A small, slowly-growing
// shared set is retained across requests (a metrics tally + a tiny response
// cache). Throughput-sensitive, and tail latency matters (one long pause = one
// slow request).
//
// What good GC behaviour looks like here: high throughput (minimize total GC
// time) AND a bounded worst-case pause (the tail). The per-request burst is
// larger than the desktop tick, so the young budget / minor cadence trades
// throughput (bigger nursery = fewer collections) against pause/footprint. Almost
// everything is young; the retained fraction is small, so majors should be rare.

const metrics = { requests: 0, bytes: 0, errors: 0 }; // long-lived tally
const responseCache = {}; // small bounded retained set
let cacheOrder = [];

function parseParams(seed) {
	// Request-scoped: an object of "query params" + an array of "headers".
	const params = {};
	for (let i = 0; i < 8; i++) {
		params["p" + i] = (seed * (i + 1)) % 251;
	}
	const headers = [];
	for (let i = 0; i < 12; i++) {
		headers.push({ name: "h" + i, value: (seed + i) & 255 });
	}
	return { params: params, headers: headers };
}

function handleRequest(seed) {
	const req = parseParams(seed);
	// Build an intermediate working set, then a response object.
	const rows = [];
	let total = 0;
	for (let i = 0; i < 24; i++) {
		const row = {
			idx: i,
			weight: req.params["p" + (i % 8)] + i,
			tag: req.headers[i % 12].value,
		};
		rows.push(row);
		total += row.weight + row.tag;
	}
	const response = { status: 200, total: total, count: rows.length, seed: seed };

	metrics.requests++;
	metrics.bytes += total;

	// Small retained cache: keep the last 256 responses' summaries.
	const key = seed & 255;
	if (responseCache[key] === undefined) {
		cacheOrder.push(key);
		if (cacheOrder.length > 256) {
			responseCache[cacheOrder.shift()] = undefined;
		}
	}
	responseCache[key] = response.total;
	return response.total;
}

let checksum = 0;
for (let r = 0; r < 350000; r++) {
	checksum = (checksum + handleRequest(r)) % 1000000007;
}
console.log(checksum + ":" + metrics.requests);
