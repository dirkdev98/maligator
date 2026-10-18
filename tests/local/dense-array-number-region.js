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

function centroid(points) {
	let sx = 0;
	let sy = 0;
	for (let index = 0; index < points.length; index++) {
		const point = points[index];
		sx += point.x;
		sy += point.y;
	}
	return `${sx},${sy}`;
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
const records = Array.from({ length: 64 }, (_, index) => ({ x: index * 0.5, y: index }));
lines.push(`records ${centroid(records)}`);
lines.push(`records again ${centroid(records)}`);
lines.push(
	`alternating shapes ${centroid([
		{ x: 1, y: 2 },
		{ y: 3, x: 4 },
		{ x: 5, y: 6 },
	])}`,
);
lines.push(
	`string field ${centroid([
		{ x: 1, y: 2 },
		{ x: "a", y: 3 },
	])}`,
);
lines.push(`missing field ${centroid([{ x: 1, y: 2 }, { x: 3 }])}`);
lines.push(
	`inherited field ${centroid([{ x: 1, y: 2 }, Object.create({ x: 7, y: 8 })])}`,
);
lines.push(
	`getter field ${centroid([
		{ x: 1, y: 2 },
		{
			get x() {
				return 9;
			},
			y: 1,
		},
	])}`,
);
lines.push(`number element ${centroid([{ x: 1, y: 2 }, 5])}`);
lines.push(
	`array element ${centroid([{ x: 1, y: 2 }, Object.assign([1], { x: 2, y: 3 })])}`,
);
const wide = { x: 1, y: 2 };
for (let field = 0; field < 40; field++) wide[`f${field}`] = field;
lines.push(`wide record ${centroid([{ x: 1, y: 2 }, wide, { x: 3, y: 4 }])}`);
try {
	centroid([{ x: 1, y: 2 }, null]);
} catch (error) {
	lines.push(`null element ${error instanceof TypeError}`);
}
if (process.env.DENSE_ARRAY_PROTOTYPE_HOLE === "1") {
	Array.prototype[1] = 100;
	show("prototype hole", sumReloaded([1, , 3]));
	delete Array.prototype[1];
}
console.log(lines.join("\n"));
