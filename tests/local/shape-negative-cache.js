"use strict";

const seed = String(Math.random());
const object = {};
for (let i = 0; i < 32; i++) {
	object[[seed, "shape", i].join("-")] = i;
}
const missingKey = [seed, "shape", "missing"].join("-");
if (Object.hasOwn(object, missingKey)) throw new Error("missing key is present");

if (typeof globalThis.__mal_reset_perf_stats !== "function") {
	throw new Error("performance control is unavailable");
}
globalThis.__mal_reset_perf_stats();
for (let i = 0; i < 512; i++) {
	if (Object.hasOwn(object, missingKey)) throw new Error("cached key is present");
}

console.log("shape-negative-cache PASS");
