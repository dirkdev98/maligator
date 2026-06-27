// GC profile: CLI / one-shot tool.
//
// Characteristics: short total lifetime, "allocate then exit". A burst of
// transient garbage is produced while transforming a fixed input, a small result
// is printed, and the process exits. Almost nothing is retained.
//
// What good GC behaviour looks like here: do as LITTLE collection work as
// possible — a process that is about to exit gains nothing from reclaiming memory
// the OS is about to reclaim wholesale. The tuning question is whether to raise
// the first-collection threshold so a short run never pays for a collection at
// all. Total allocation is deliberately bounded (a few tens of MB) so it sits
// near the default 16 MB trigger — the regime where the policy choice matters.

function tokenize(line) {
	// Per-line transient garbage: an array of small string/number records.
	const out = [];
	let n = 0;
	for (let i = 0; i < line.length; i++) {
		const c = line.charCodeAt(i);
		if (c === 32) {
			out.push({ kind: "sep", at: i });
			n++;
		} else {
			out.push({ kind: "ch", code: c, at: i });
		}
	}
	return { tokens: out, seps: n };
}

let checksum = 0;
// One pass over synthetic "input lines" — the whole job, then exit.
for (let line = 0; line < 6000; line++) {
	const text = "the quick brown fox " + line + " jumps over the lazy dog";
	const r = tokenize(text);
	checksum = (checksum + r.tokens.length * 3 + r.seps) % 1000000007;
}
console.log(checksum);
