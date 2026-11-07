const util = require("./util.cjs");

function sum(count) {
	let total = 0;
	for (let index = 0; index < count; index++)
		total = util.add(total, util.scale(index & 7)) | 0;
	return total;
}

const results = [sum(1000)];
// A guessed export stays a guess: replacing it takes the generic call.
util.add = (a, b) => a - b;
results.push(sum(1000));
util.factor = 5;
results.push(sum(1000));
const gc = globalThis.__mal_collect_garbage;
if (typeof gc === "function") gc();
util.scale = Math.abs;
results.push(sum(1000));
console.log(results.join(" "));
