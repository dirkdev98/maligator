// Dense Array element sums run in an unboxed loop region; every other element
// shape must decline before it is read and finish in the original loop.
function sumReloaded(values) {
	let total = 0;
	for (let index = 0; index < values.length; index++) total += values[index];
	return total;
}

function sumHoisted() {
	const values = Array.from({ length: 4096 }, (_, index) => (index & 255) * 0.5);
	let total = 0;
	for (let round = 0; round < 8; round++) {
		for (let index = 0; index < values.length; index++) total += values[index];
	}
	return total;
}

const lines = [];
const show = (label, value) =>
	lines.push(`${label} ${String(value)} ${Object.is(value, -0)}`);
show("integers", sumReloaded([1, 2, 3, 4]));
show("doubles", sumReloaded([0.1, 0.2, 0.3]));
show("negative zero", sumReloaded([-0, -0]));
show("special numbers", sumReloaded([1, NaN, Infinity]));
show("infinities", sumReloaded([Infinity, -Infinity]));
show("string element", sumReloaded([1, 2, "x", 4]));
show("object element", sumReloaded([1, { valueOf: () => 7 }, 2]));
show("hole", sumReloaded([1, , 3]));
const trailing = [1, 2];
trailing.length = 4;
show("trailing holes", sumReloaded(trailing));
show("empty", sumReloaded([]));
show("int32 overflow", sumReloaded([2147483647, 1]));
show("hoisted", sumHoisted());
const growing = [1, 2, 3];
let grown = 0;
for (let round = 0; round < 4; round++) {
	grown += sumReloaded(growing);
	growing.push(round + 0.5);
}
show("grown", grown);
if (process.env.DENSE_ARRAY_PROTOTYPE_HOLE === "1") {
	Array.prototype[1] = 100;
	show("prototype hole", sumReloaded([1, , 3]));
	delete Array.prototype[1];
}
console.log(lines.join("\n"));
