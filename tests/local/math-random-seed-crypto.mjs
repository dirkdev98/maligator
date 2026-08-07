// The same four draws, from a program that also links node:crypto.
//
// Importing the module is the whole point: installing it registers the host
// CSPRNG as Math.random's seed source, so this covers the branch the bare
// fixture cannot reach. randomBytes is called so the import cannot be dropped
// as unused.
import { randomBytes } from "node:crypto";

if (randomBytes(1).length !== 1) throw new Error("randomBytes is unavailable");

const draws = [];
for (let i = 0; i < 4; i++) draws.push(Math.random());

const inUnitInterval = draws.every((value) => value >= 0 && value < 1);
const distinct = new Set(draws).size === draws.length;
console.log(`DRAWS ${draws.join(",")}`);
console.log(`RESULT ${inUnitInterval && distinct ? 2 : 0}/2`);
