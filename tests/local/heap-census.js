// A known live population of exotic objects for the heap census diagnostic.
const COUNT = 1000;
const retained = [];
for (let i = 0; i < COUNT; i++) {
	retained.push(new Map([[i, i]]), new Set([i]), new Date(i), Promise.resolve(i));
}
globalThis.retained = retained;
console.log("heap-census PASS " + retained.length);
