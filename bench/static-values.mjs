function search(value, from) {
	return ["alpha", "beta", "gamma", "delta"].includes(value, from);
}

function unused(value, from) {
	["alpha", "beta", "gamma", "delta"].includes(value, from);
}

function never(value) {
	return [{ value: [1, 2, 3] }, { value: [4, 5, 6] }].includes(value);
}

globalThis.staticValueWorkload = { search, unused, never };
const mode = process.argv[2] ?? "hot";
const iterations = mode === "hot" ? 200_000 : mode === "cold" ? 1 : 0;
let checksum = 0;
let coercions = 0;
const from = {
	valueOf() {
		coercions++;
		return 0;
	},
};
const started = Date.now();
for (let i = 0; i < iterations; i++) {
	checksum += search(i & 1 ? "beta" : "missing", 0) ? 1 : 0;
	unused("alpha", from);
}
console.log(JSON.stringify({ mode, iterations, checksum, coercions }));
console.error(`[static-values-workload] elapsed_ms=${Date.now() - started}`);
if (typeof globalThis.__mal_collect_garbage === "function") {
	globalThis.__mal_collect_garbage();
	console.error(
		`[static-values-memory] retained_bytes=${globalThis.__mal_gc_live_bytes()}`,
	);
}
