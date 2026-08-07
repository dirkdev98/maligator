// Prints the first four Math.random() draws so a caller can compare two runs.
//
// This fixture deliberately imports nothing: it exercises the seed path a
// program gets when it links no crypto surface at all, which is the path that
// used to be `time(nullptr) | 1` and therefore identical across two processes
// started in the same second.
const draws = [];
for (let i = 0; i < 4; i++) draws.push(Math.random());

const inUnitInterval = draws.every((value) => value >= 0 && value < 1);
const distinct = new Set(draws).size === draws.length;
console.log(`DRAWS ${draws.join(",")}`);
console.log(`RESULT ${inUnitInterval && distinct ? 2 : 0}/2`);
