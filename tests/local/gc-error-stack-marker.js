const gc = globalThis.__mal_collect_garbage;
if (typeof gc !== "function") throw new Error("GC hook unavailable");

gc();
const error = new Error("stack marker survived collection");
if (!error.stack.includes("stack marker survived collection")) {
	throw new Error("Error stack was not captured after collection");
}
gc();
if (!error.stack.includes("stack marker survived collection")) {
	throw new Error("Error stack was lost after collection");
}
console.log("gc-error-stack-marker PASS 1/1");
