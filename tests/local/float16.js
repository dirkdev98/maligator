const results = [];

function check(name, condition) {
	results.push([name, condition]);
}

const buffer = new ArrayBuffer(2);
const view = new DataView(buffer);

function bits(value) {
	view.setFloat16(0, value);
	return view.getUint16(0);
}

function fromBits(value) {
	view.setUint16(0, value);
	return view.getFloat16(0);
}

const minSubnormal = Math.pow(2, -24);
check("positive zero bits", bits(0) === 0x0000);
check("negative zero bits", bits(-0) === 0x8000);
check("positive zero value", Object.is(fromBits(0x0000), 0));
check("negative zero value", Object.is(fromBits(0x8000), -0));

check("normal encode", bits(1) === 0x3c00 && bits(-2) === 0xc000);
check("normal decode", fromBits(0x3555) === 0.333251953125);
check("minimum subnormal", bits(minSubnormal) === 0x0001);
check("largest subnormal", fromBits(0x03ff) === 1023 * minSubnormal);
check("minimum normal", fromBits(0x0400) === Math.pow(2, -14));
check("underflow below midpoint", bits(Math.pow(2, -26)) === 0x0000);
check("underflow midpoint ties to zero", bits(Math.pow(2, -25)) === 0x0000);
check("underflow above midpoint", bits(Math.pow(2, -25) + Math.pow(2, -50)) === 0x0001);

check("normal tie rounds to lower even", bits(1 + Math.pow(2, -11)) === 0x3c00);
check("normal tie rounds to upper even", bits(1 + 3 * Math.pow(2, -11)) === 0x3c02);
check("negative lower-even tie", bits(-1 - Math.pow(2, -11)) === 0xbc00);
check("negative upper-even tie", bits(-1 - 3 * Math.pow(2, -11)) === 0xbc02);
check("subnormal tie rounds to lower even", bits(0.5 * minSubnormal) === 0x0000);
check("subnormal tie rounds to upper even", bits(1.5 * minSubnormal) === 0x0002);

check("largest finite", bits(65504) === 0x7bff && fromBits(0x7bff) === 65504);
check("below overflow midpoint", bits(65519) === 0x7bff);
check("overflow midpoint", bits(65520) === 0x7c00);
check("positive infinity", bits(Infinity) === 0x7c00 && fromBits(0x7c00) === Infinity);
check("negative infinity", bits(-Infinity) === 0xfc00 && fromBits(0xfc00) === -Infinity);
check("canonical NaN store", bits(NaN) === 0x7e00);
check("NaN load", Number.isNaN(fromBits(0x7c01)) && Number.isNaN(fromBits(0xffff)));

view.setFloat16(0, 1);
check("big-endian raw packing", view.getUint8(0) === 0x3c && view.getUint8(1) === 0x00);
view.setFloat16(0, 1, true);
check(
	"little-endian raw packing",
	view.getUint8(0) === 0x00 && view.getUint8(1) === 0x3c,
);
check("little-endian raw load", view.getFloat16(0, true) === 1);

const consistencyInputs = [
	0,
	-0,
	1,
	-2,
	minSubnormal,
	1.5 * minSubnormal,
	Math.pow(2, -25),
	1 + Math.pow(2, -11),
	1 + 3 * Math.pow(2, -11),
	65504,
	65520,
	Infinity,
	-Infinity,
	NaN,
];
let consistent = true;
for (const input of consistencyInputs) {
	const viaMath = Math.f16round(input);
	const viaDataView = fromBits(bits(input));
	if (
		!(
			Object.is(viaMath, viaDataView) ||
			(Number.isNaN(viaMath) && Number.isNaN(viaDataView))
		)
	) {
		consistent = false;
	}
}
check("DataView and Math consistency", consistent);
check("Math signed zero", Object.is(Math.f16round(-0), -0));
check("Math underflow signed zero", Object.is(Math.f16round(-Math.pow(2, -25)), -0));
check(
	"Math infinities",
	Math.f16round(Infinity) === Infinity && Math.f16round(-Infinity) === -Infinity,
);
check("Math NaN", Number.isNaN(Math.f16round(NaN)));

for (const [name, passed] of results) {
	if (!passed) console.log("FAIL: " + name);
}
console.log(
	"RESULT " + results.filter(([, passed]) => passed).length + "/" + results.length,
);
