const gc = globalThis.__mal_collect_garbage;
if (typeof gc !== "function") throw new Error("GC hook unavailable");

const roots = [];
let shared;
for (let i = 0; i < 4096; i++) {
	if (i % 2 === 0) shared = { value: i };
	roots.push({ left: shared, right: shared });
}

function* suspendedGraph() {
	const hidden = [];
	for (let i = 0; i < 1024; i++) hidden.push({ value: i });
	yield 1;
	return hidden[1023].value;
}
function makeSuspendedGraph() {
	const generator = suspendedGraph();
	generator.next();
	return generator;
}
roots[0].generator = makeSuspendedGraph();

function makeWeakChain() {
	const first = new WeakMap();
	const second = new WeakMap();
	const key1 = {};
	const key2 = {};
	const children = [];
	for (let i = 0; i < 1024; i++) children.push({ value: i });
	first.set(key1, key2);
	second.set(key2, { children });
	return { first, second, key1 };
}
roots[1].weakChain = makeWeakChain();

gc();
for (let i = 0; i < roots.length; i++) {
	if (
		roots[i].left !== roots[i].right ||
		roots[i].left.value !== i - (i % 2) ||
		roots[i].left !== roots[i - (i % 2)].left
	) {
		throw new Error("parallel trace lost a reachable edge at " + i);
	}
}
if (roots[0].generator.next().value !== 1023) {
	throw new Error("deferred generator lost its frame graph");
}
const chain = roots[1].weakChain;
const key2 = chain.first.get(chain.key1);
if (key2 === undefined || chain.second.get(key2).children[1023].value !== 1023) {
	throw new Error("ephemeron fixpoint lost worker-discovered graph");
}
console.log("gc-worker-batches PASS 1/1");
