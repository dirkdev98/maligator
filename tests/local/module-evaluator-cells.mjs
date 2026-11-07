const results = [];

// A function reads the cell while the module body keeps assigning it.
let current = "";
function snapshot() {
	return current.length;
}
let seen = 0;
for (let index = 0; index < 50; index++) {
	current = "x".repeat(index % 7);
	seen += snapshot() + current.length;
}
results.push(seen);

// Another writer keeps every read of its cell in memory.
let counter = 0;
const writers = {
	bump() {
		counter += 10;
	},
};
const name = globalThis.writerName ?? "bump";
for (let index = 0; index < 5; index++) {
	counter++;
	writers[name]();
	results.push(counter);
}

// Paths that disagree join their values.
let joined = 0;
for (let index = 0; index < 20; index++) {
	if (index % 3 === 0) joined += index;
	else if (index % 3 === 1) joined = joined * 2;
	joined += 1;
}
results.push(joined);

let text = "";
let checksum = 2166136261;
for (let iteration = 0; iteration < 30; iteration++) {
	text = JSON.stringify({ iteration, items: [iteration, iteration * 2] });
	for (let index = 0; index < text.length; index++)
		checksum = Math.imul(checksum ^ text.charCodeAt(index), 16777619) >>> 0;
}
const gc = globalThis.__mal_collect_garbage;
if (typeof gc === "function") gc();
results.push(checksum, text);

// A function only the module body calls moves into it, cells and all.
const stats = { hits: 0, misses: 0 };
function tally(count) {
	for (let index = 0; index < count; index++)
		if (index % 3 === 0) stats.misses++;
		else stats.hits++;
}
tally(100);
results.push(stats.hits, stats.misses);

// A handler reads what the stores left, and a read before the declaration still throws.
let handled = 0;
for (let index = 0; index < 10; index++) {
	try {
		handled += index;
		if (index === 7) throw new Error("boom");
	} catch {
		handled -= 100;
	}
}
results.push(handled);
try {
	results.push(early);
} catch (error) {
	results.push(error instanceof ReferenceError ? "tdz" : "wrong");
}
let early = 1;
results.push(early);
console.log(results.join(" "));
