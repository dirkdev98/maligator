import { makeLookup } from "./captured-local-dependency.mjs";

const first = makeLookup([2, 3]);
const second = makeLookup([5]);
if (first(2) !== 4 || first(3) !== 6 || first(5) !== undefined || second(5) !== 10)
	throw new Error("module function activations do not retain their own captured locals");
console.log("RESULT 1/1");
