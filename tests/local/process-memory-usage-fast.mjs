function check(value, message) {
	if (!value) throw new Error(message);
}

const baseline = process.memoryUsage().arrayBuffers;

function exercise() {
	const source = new ArrayBuffer(64, { maxByteLength: 128 });
	check(
		process.memoryUsage().arrayBuffers === baseline + 128,
		"resizable buffer counts reserved capacity",
	);
	source.resize(16);
	check(
		process.memoryUsage().arrayBuffers === baseline + 128,
		"resize retains backing capacity",
	);
	const moved = source.transferToFixedLength(8);
	check(source.byteLength === 0 && moved.byteLength === 8, "store moved to fixed buffer");
	check(
		process.memoryUsage().arrayBuffers === baseline + 128,
		"move preserves one backing owner",
	);
	const copied = structuredClone(moved);
	check(
		process.memoryUsage().arrayBuffers === baseline + 136,
		"clone adds one destination backing",
	);
	const transferred = structuredClone(copied, { transfer: [copied] });
	const usage = process.memoryUsage();
	check(
		copied.byteLength === 0 && transferred.byteLength === 8,
		"clone transfer detached source",
	);
	check(
		usage.arrayBuffers === baseline + 136 &&
			usage.external >= usage.arrayBuffers &&
			usage.heapTotal >= usage.heapUsed,
		"serialization moves the backing without changing total ownership",
	);
	check(
		moved.byteLength === 8 && new Uint8Array(moved)[0] === 0,
		"moved backing remains live",
	);
	check(transferred.byteLength === 8, "transferred backing remains live");
}

exercise();
const collect = globalThis.__mal_collect_garbage;
check(typeof collect === "function", "host GC hook is available");
collect();
check(
	process.memoryUsage().arrayBuffers <= baseline,
	"collection releases ordinary backings",
);
console.log("process-memory-usage-fast PASS");
