function check(value, message) {
	if (!value) throw new Error(message);
}

const baseline = process.memoryUsage().arrayBuffers;
// Fixed stores up to 256 bytes live in the buffer's heap cell and count as heap
// memory, so every fixed length here stays above that.
const fixedLength = 384;

function exercise() {
	const source = new ArrayBuffer(512, { maxByteLength: 1024 });
	check(
		process.memoryUsage().arrayBuffers === baseline + 1024,
		"resizable buffer counts reserved capacity",
	);
	source.resize(16);
	check(
		process.memoryUsage().arrayBuffers === baseline + 1024,
		"resize retains backing capacity",
	);
	const moved = source.transferToFixedLength(fixedLength);
	check(
		source.byteLength === 0 && moved.byteLength === fixedLength,
		"store moved to fixed buffer",
	);
	check(
		process.memoryUsage().arrayBuffers === baseline + 1024,
		"move preserves one backing owner",
	);
	const copied = structuredClone(moved);
	check(
		process.memoryUsage().arrayBuffers === baseline + 1024 + fixedLength,
		"clone adds one destination backing",
	);
	const transferred = structuredClone(copied, { transfer: [copied] });
	const usage = process.memoryUsage();
	check(
		copied.byteLength === 0 && transferred.byteLength === fixedLength,
		"clone transfer detached source",
	);
	check(
		usage.arrayBuffers === baseline + 1024 + fixedLength &&
			usage.external >= usage.arrayBuffers &&
			usage.heapTotal >= usage.heapUsed,
		"serialization moves the backing without changing total ownership",
	);
	check(
		moved.byteLength === fixedLength && new Uint8Array(moved)[0] === 0,
		"moved backing remains live",
	);
	check(transferred.byteLength === fixedLength, "transferred backing remains live");
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
