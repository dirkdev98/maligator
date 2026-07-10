// Module-mode allocation benchmark. ES-module top-level `const`-bound helpers
// composed in a hot loop that builds short-lived vector records. This is the code
// shape language.js does NOT cover: it uses function-local consts and script-mode
// `function` declarations, which resolve through other paths.
//
// Why it belongs on its own line: in an ES module (and for top-level `const`/`let`
// in general) every read of a lexical binding emits a TDZ guard. Once that guard
// is modelled as a use rather than a definition, the single-assignment analyses
// resolve these const-bound callees, the inliner fires through the whole
// `vec`/`add`/`scale`/… composition, and scalar replacement eliminates every
// transient the helpers return — the loop body allocates nothing. A regression in
// that chain is loud here: GC collections jump from zero to hundreds and wall time
// multiplies (measured ~5x). The consolidated tracker reports the collection count
// as the primary signal precisely because it is binary and noise-free — a healthy
// build is exactly 0.
//
// Bounded, deterministic; prints one checksum (bit-identical to V8).

const vec = (x, y, z) => ({ x, y, z });
const add = (a, b) => vec(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a, b) => vec(a.x - b.x, a.y - b.y, a.z - b.z);
const scale = (a, s) => vec(a.x * s, a.y * s, a.z * s);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const lerp = (a, b, t) => add(scale(a, 1 - t), scale(b, t));

const GRAVITY = vec(0, -9.81, 0);
const DT = 0.016;

let checksum = 0;
for (let i = 0; i < 2000000; i++) {
	const p = vec(i % 100, (i * 3) % 100, (i * 7) % 100);
	const v = vec((i * 5) % 50, (i * 11) % 50, (i * 13) % 50);
	const acc = add(scale(GRAVITY, DT), scale(v, 0.5));
	const p2 = add(p, scale(acc, DT));
	const mid = lerp(p, p2, 0.5);
	const d = sub(p2, mid);
	checksum = (checksum + dot(d, d)) % 1000000007;
}
console.log(checksum);
