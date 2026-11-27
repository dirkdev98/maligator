// A CommonJS module's top-level declarations are bindings of its wrapper function.
const values = [];
for (let index = 0; index < 40; index++) values.push(index);

function double(value) {
	return value * 2;
}
function isEven(value) {
	return value % 2 === 0;
}
function argumentCount() {
	return arguments.length;
}
function sloppyThis() {
	return this === globalThis;
}
function rebound(value) {
	return value + 1;
}

let total = 0;
for (let round = 0; round < 20; round++) {
	total += values.map(double).filter(isEven).length;
	total += values.map(argumentCount).reduce((sum, count) => sum + count, 0);
}
console.log("total", total);
console.log("sloppy this", [1, 2].map(sloppyThis).join());

const results = [];
for (let round = 0; round < 4; round++) {
	results.push(values.map(rebound).reduce((sum, value) => sum + value, 0));
	if (round === 1)
		rebound = function (value) {
			return value - 1;
		};
}
console.log("rebound", results.join());
module.exports = { double };
