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

function sumOf(values) {
	let total = 0;
	for (const value of values) total += value;
	return total;
}

function centroidOf(points) {
	let sx = 0;
	let sy = 0;
	for (const point of points) {
		sx += point.x;
		sy += point.y;
	}
	return `${sx},${sy}`;
}

function fnvHash(values, seed) {
	let hash = seed;
	for (let index = 0; index < values.length; index++)
		hash = Math.imul(hash ^ values[index], 0x01000193) >>> 0;
	return hash;
}

function bitMix(values, seed) {
	let low = seed;
	let high = 0;
	for (const value of values) {
		low = (low << 3) ^ ~value;
		high = (high | (value >> 1)) + (low & 255);
	}
	return `${low},${high},${Object.is(low, -0)}`;
}

function clzSum(values, seed) {
	let total = 0;
	for (let index = 0; index < values.length; index++)
		total += Math.clz32(values[index] ^ seed);
	return total;
}

function lookupSum(table, count, mask) {
	let total = 0;
	for (let index = 0; index < count; index++) total += table[index & mask];
	return total;
}

function shiftedLookupSum(table, count) {
	let total = 0;
	for (let index = 0; index < count; index++) total += table[(index & 3) - 1];
	return total;
}

function halfLookupSum(table, count) {
	let total = 0;
	for (let index = 0; index < count; index++) total += table[(index & 3) / 2];
	return total;
}

function recordLookup(points, count, mask) {
	let total = 0;
	for (let index = 0; index < count; index++) total += points[index & mask].x;
	return total;
}

function destructuredCentroidOf(points) {
	let sx = 0;
	let sy = 0;
	for (const { x, y } of points) {
		sx += x;
		sy += y;
	}
	return `${sx},${sy}`;
}

function sumUntilNegative(values) {
	let total = 0;
	for (const value of values) {
		if (value < 0) break;
		total += value;
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
const iterated = Array.from({ length: 128 }, (_, index) => index * 0.5);
lines.push(`for-of numbers ${sumOf(iterated)} ${sumOf(iterated)}`);
lines.push(`for-of hole ${sumOf([1, , 3])}`);
const iteratedTrailing = [1, 2];
iteratedTrailing.length = 3;
lines.push(`for-of trailing hole ${sumOf(iteratedTrailing)}`);
lines.push(`for-of string ${sumOf([1, "b", 2])}`);
lines.push(`for-of empty ${sumOf([])}`);
lines.push(`for-of records ${centroidOf(records)}`);
lines.push(`for-of mixed records ${centroidOf([{ x: 1, y: 2 }, { y: 3, x: 4 }, 5])}`);
const hashed = Array.from({ length: 64 }, (_, index) => (index * 2654435761) % 1000003);
lines.push(`fnv ${fnvHash(hashed, 0x811c9dc5)}`);
lines.push(`fnv fractional seed ${fnvHash(hashed, 1.5)}`);
lines.push(`fnv empty negative zero ${Object.is(fnvHash([], -0), -0)}`);
lines.push(
	`fnv odd elements ${fnvHash([1.5, -2.25, 2 ** 40 + 3, -(2 ** 33), 4294967295], 7)}`,
);
lines.push(`bit mix ${bitMix([1, -2, 3, 0x7fffffff, -0x80000000], 5)}`);
lines.push(`bit mix empty ${bitMix([], -0)}`);
lines.push(`bit mix large seed ${bitMix([3, 4], 4294967295)}`);
lines.push(`clz ${clzSum([0, 1, -1, 2 ** 31, 0.5, 2 ** 40], 6)}`);
lines.push(`lookup ${lookupSum([1, 2, 3, 4], 100, 3)}`);
lines.push(`lookup past the end ${lookupSum([1, 2, 3], 10, 3)}`);
lines.push(`lookup hole ${lookupSum([1, , 3, 4], 10, 3)}`);
lines.push(`lookup Float64Array ${lookupSum(new Float64Array([0.5, 1.5]), 10, 1)}`);
lines.push(`lookup Int16Array ${lookupSum(new Int16Array([1, -2, 3, 4]), 10, 3)}`);
const negative = [10, 20, 30];
negative[-1] = 5;
lines.push(`lookup negative key ${shiftedLookupSum(negative, 12)}`);
const fractional = [10, 20, 30];
fractional["0.5"] = 7;
fractional["1.5"] = 9;
lines.push(`lookup fractional key ${halfLookupSum(fractional, 12)}`);
lines.push(`lookup records ${recordLookup(records, 64, 15)}`);
lines.push(
	`lookup mixed records ${recordLookup([{ x: 1 }, { y: 2, x: 3 }, { x: "4" }, 5], 8, 3)}`,
);
lines.push(`for-of destructured records ${destructuredCentroidOf(records)}`);
lines.push(
	`for-of destructured mixed records ${destructuredCentroidOf([{ x: 1, y: 2 }, { y: 3, x: 4 }, 5])}`,
);
try {
	destructuredCentroidOf([{ x: 1, y: 2 }, null, { x: 3, y: 4 }]);
} catch (error) {
	lines.push(`for-of destructured null ${error instanceof TypeError}`);
}
lines.push(`for-of break ${sumUntilNegative([1, 2, 3, -1, 100])}`);
if (process.env.DENSE_ARRAY_PROTOTYPE_HOLE === "1") {
	Array.prototype[1] = 100;
	show("prototype hole", sumReloaded([1, , 3]));
	show("for-of prototype hole", sumOf([1, , 3]));
	delete Array.prototype[1];
}
console.log(lines.join("\n"));
