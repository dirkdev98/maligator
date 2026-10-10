// Views reach the reads through an opaque holder, so the compiler cannot prove their kind.
const kinds = [
	Int8Array,
	Uint8Array,
	Uint8ClampedArray,
	Int16Array,
	Uint16Array,
	Int32Array,
	Uint32Array,
	Float32Array,
	Float64Array,
	BigInt64Array,
];
const holders = [];
function hold(view) {
	holders.push({ view });
	return holders.length - 1;
}
function read(slot, index) {
	return holders[slot].view[index];
}
function write(slot, index, value) {
	holders[slot].view[index] = value;
}
function describe(value) {
	if (typeof value === "bigint") return `${value}n`;
	return Object.is(value, -0) ? "-0" : String(value);
}

const output = [];
for (const Kind of kinds) {
	const view = new Kind(6);
	const big = Kind === BigInt64Array;
	for (let index = 0; index < view.length; index++) {
		const value = (index - 2) * 70000.75;
		view[index] = big ? BigInt(Math.trunc(value)) : value;
	}
	if (!big && Kind !== Uint8ClampedArray)
		view[5] = Kind.name.startsWith("Float") ? NaN : -1;
	const slot = hold(view);
	const reads = [];
	for (const index of [0, 1, 2, 5, -0, 6, -1, 1.5, 2 ** 32, NaN]) {
		reads.push(describe(read(slot, index)));
	}
	output.push(`${Kind.name} ${reads.join(",")}`);
}

for (const Kind of kinds) {
	if (Kind === BigInt64Array) continue;
	const slot = hold(new Kind(8));
	const values = [300, -129, 70000.75, -0, NaN, 2 ** 40 + 3, -2147483648, 0.5];
	for (let index = 0; index < values.length; index++) write(slot, index, values[index]);
	write(slot, 8, 1);
	write(slot, 1.5, 1);
	const reads = [];
	for (let index = 0; index < 9; index++) reads.push(describe(read(slot, index)));
	output.push(`${Kind.name} writes ${reads.join(",")}`);
}

const offset = new Int16Array(new ArrayBuffer(16), 4, 3);
offset[0] = -7;
offset[2] = 300;
const offsetSlot = hold(offset);
output.push(
	`offset ${read(offsetSlot, 0)},${read(offsetSlot, 2)},${read(offsetSlot, 3)}`,
);

Object.defineProperty(Int32Array.prototype, "1", {
	get: () => "prototype",
	configurable: true,
});
const prototypeSlot = hold(new Int32Array([4, 5]));
output.push(`prototype ${read(prototypeSlot, 1)},${read(prototypeSlot, 2)}`);
delete Int32Array.prototype[1];

const resizable = new ArrayBuffer(16, { maxByteLength: 32 });
const fixed = new Uint32Array(resizable, 0, 4);
fixed[3] = 4000000000;
const fixedSlot = hold(fixed);
const tracking = new Uint32Array(resizable);
const trackingSlot = hold(tracking);
output.push(`resizable ${read(fixedSlot, 3)},${read(trackingSlot, 3)}`);
resizable.resize(8);
write(fixedSlot, 0, 9);
write(trackingSlot, 1, 11);
output.push(
	`shrunk ${read(fixedSlot, 0)},${read(trackingSlot, 1)},${read(trackingSlot, 3)}`,
);

const detachable = new Float64Array([1.25, 2.5]);
const detachableSlot = hold(detachable);
output.push(`attached ${read(detachableSlot, 1)}`);
detachable.buffer.transfer();
write(detachableSlot, 0, 7);
output.push(`detached ${read(detachableSlot, 1)},${read(detachableSlot, 0)}`);

for (const line of output) console.log(line);
