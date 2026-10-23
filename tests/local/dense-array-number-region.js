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

function wrappingRecordSum(points, seed) {
	let sum = seed;
	for (let index = 0; index < points.length; index++)
		sum = (sum + Math.imul(points[index].x, points[index].y)) | 0;
	return sum;
}

function widestSpan(values) {
	let widest = 0;
	let last = 0;
	for (const value of values) {
		last = (value >>> 0) - (value | 0);
		if (last > widest) widest = last;
	}
	return `${widest},${last},${Object.is(last, -0)}`;
}

function descendingPairs(values) {
	let total = 0;
	let index = values.length - 1;
	for (; index >= 0; index -= 2) total += values[index] * index;
	return `${total},${index}`;
}

function adjacentDifferences(values) {
	let total = 0;
	let index = 0;
	for (; index + 1 < values.length; index++) total += values[index + 1] - values[index];
	return `${total},${index}`;
}

function binarySearch(items, target) {
	let lo = 0;
	let hi = items.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const value = items[mid];
		if (value === target) return mid;
		if (value < target) lo = mid + 1;
		else hi = mid - 1;
	}
	return -1 - lo;
}

function probeSlot(table, key, mask) {
	let slot = (key * 31) & mask;
	let steps = 0;
	while (table[slot] !== 0 && table[slot] !== key) {
		slot = (slot + 1) & mask;
		steps++;
	}
	return `${slot},${steps}`;
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
const products = Array.from({ length: 64 }, (_, index) => ({
	x: (index * 2654435761) % 4294967296,
	y: (index * 40503) | 0,
}));
lines.push(`wrapping sum ${wrappingRecordSum(products, 0)}`);
lines.push(`wrapping sum unsigned seed ${wrappingRecordSum(products, 4294967295)}`);
lines.push(`wrapping sum fractional seed ${wrappingRecordSum(products, 0.5)}`);
lines.push(`wrapping sum wide seed ${wrappingRecordSum(products, 2 ** 40)}`);
lines.push(`wrapping sum negative zero ${Object.is(wrappingRecordSum([], -0), -0)}`);
lines.push(
	`wrapping sum fractional field ${wrappingRecordSum([{ x: 2.5, y: 3 }, ...products], 7)}`,
);
lines.push(`span ${widestSpan([-1, 2 ** 31, 5, -(2 ** 31), 0.5, -0])}`);
lines.push(`span empty ${widestSpan([])}`);
lines.push(`descending ${descendingPairs([1, 2, 3, 4, 5, 6, 7])}`);
lines.push(`descending even ${descendingPairs([1.5, 2, 3, 4])}`);
lines.push(`descending hole ${descendingPairs([1, 2, , 4, 5])}`);
lines.push(`adjacent ${adjacentDifferences([1, 4, 9, 16, 25.5])}`);
lines.push(`adjacent single ${adjacentDifferences([7])}`);
lines.push(`adjacent empty ${adjacentDifferences([])}`);
lines.push(`adjacent hole ${adjacentDifferences([1, 2, , 4])}`);
lines.push(`adjacent string ${adjacentDifferences([1, 2, "3", 4])}`);
const sorted = Array.from({ length: 100 }, (_, index) => index * 3 - 50);
const searches = [-50, -49, 0, 1, 247, 248, 1000, -1000, 0.5, NaN];
lines.push(`search ${searches.map((target) => binarySearch(sorted, target)).join(",")}`);
lines.push(
	`search Float64Array ${searches.map((target) => binarySearch(new Float64Array(sorted), target)).join(",")}`,
);
lines.push(
	`search Int8Array ${searches.map((target) => binarySearch(new Int8Array([-50, -3, 0, 4, 90]), target)).join(",")}`,
);
lines.push(`search empty ${binarySearch([], 3)}`);
lines.push(
	`search hole ${binarySearch([1, 3, , 7, 9], 7)},${binarySearch([1, 3, , 7, 9], 4)}`,
);
lines.push(
	`search string ${binarySearch([1, 3, "5", 7, 9], 5)},${binarySearch([1, 3, "5", 7, 9], 8)}`,
);
lines.push(`search fractional ${binarySearch([0.5, 1.5, 2.5, 3.5], 2.5)}`);
const slots = new Int32Array(16);
for (const key of [5, 21, 37, 9])
	slots[Number(probeSlot(slots, key, 15).split(",")[0])] = key;
lines.push(
	`probe ${[5, 21, 37, 9, 53, 0].map((key) => probeSlot(slots, key, 15)).join(" ")}`,
);
lines.push(`probe past the end ${probeSlot(new Int32Array([7, 7, 7, 0]), 3, 7)}`);
lines.push(`probe Array ${probeSlot([0, 0, 0, 5, 21, 0, 0, 0], 21, 7)}`);
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
