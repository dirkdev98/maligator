const MOD = 1_000_000_007;
const collectGarbage = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});
const events = [];

function sum(total, a, b, c) {
	return (total + a + b + c) % MOD;
}

function mixed(total, a, b) {
	return total * a - b / 2 + a;
}

function primitiveFusionStart(left, right, flag, other) {
	const value = flag ? !!other : null;
	return (value + left) * right;
}

function primitiveFusionFinish(left, right, flag, other) {
	const value = flag ? !!other : null;
	return (left + right) * value;
}

function primitiveFusionLink(left, right, flag, other) {
	const value = flag ? !!other : null;
	return (left + right + value) * other;
}

function primitiveFusionStringStart(left, right, flag, other) {
	const value = flag ? "2" : !!other;
	return (value + left) * right;
}

function primitiveFusionStringLink(left, right, flag, other) {
	const value = flag ? "2" : !!other;
	return (left + right + value) * other;
}

function primitiveFusionStringFinish(left, right, flag, other) {
	const value = flag ? "2" : !!other;
	return (left + right) * value;
}

function primitiveFusionStringCompare(left, right, flag) {
	const value = flag ? "2" : "10";
	return left + right < value;
}

function primitiveFusionReverseCompare(left, right, flag) {
	const value = flag ? "2" : "10";
	return value < left + right;
}

function primitiveFusionStrict(left, right, flag, other) {
	const value = flag ? !!other : +other;
	return left + right === value;
}

function primitiveFusionLoose(left, right, flag, other) {
	const value = flag ? !!other : +other;
	return left + right == value;
}

function primitiveFusionManaged(left, right, flag, other, symbol) {
	const value = flag ? +other : symbol ? Symbol(other) : BigInt(other);
	return (left + right) * value;
}

function primitiveFusionPartial(left, right, other, tail) {
	return (left + right) * other + tail;
}

function* resumablePrimitiveFusion(left, right, flag, other) {
	const value = flag ? !!other : null;
	yield "resume";
	return (left + right) * value;
}

globalThis.primitiveFusionStart = primitiveFusionStart;
globalThis.primitiveFusionFinish = primitiveFusionFinish;
globalThis.primitiveFusionLink = primitiveFusionLink;
globalThis.primitiveFusionStringStart = primitiveFusionStringStart;
globalThis.primitiveFusionStringLink = primitiveFusionStringLink;
globalThis.primitiveFusionStringFinish = primitiveFusionStringFinish;
globalThis.primitiveFusionStringCompare = primitiveFusionStringCompare;
globalThis.primitiveFusionReverseCompare = primitiveFusionReverseCompare;
globalThis.primitiveFusionStrict = primitiveFusionStrict;
globalThis.primitiveFusionLoose = primitiveFusionLoose;
globalThis.primitiveFusionManaged = primitiveFusionManaged;
globalThis.primitiveFusionPartial = primitiveFusionPartial;
globalThis.resumablePrimitiveFusion = resumablePrimitiveFusion;

function score(rows) {
	let total = 0;
	for (const row of rows) total = sum(total, row.a, row.b, row.c);
	return total;
}

function traced(label, value) {
	return {
		valueOf() {
			events.push(label);
			collectGarbage();
			return value;
		},
	};
}

function show(value) {
	return Object.is(value, -0) ? "-0" : String(value);
}

const rows = [];
for (let index = 0; index < 4096; index++)
	rows.push({ a: index * 3, b: (index * 7) % 11, c: index % 5 });
const outputs = [score(rows)];
outputs.push(
	sum(1, 2, 3, 4),
	sum(1.5, -0, 2 ** 53, 7),
	sum(0, NaN, 1, 2),
	sum(-0, -0, -0, -0),
);
outputs.push(sum("x", 1, 2, 3), sum(1, "y", 2, 3), sum(1, 2, "z", 3), sum(1, 2, 3, "w"));
outputs.push(sum(1, traced("a", 2), traced("b", 3), traced("c", 4)), events.join(","));
outputs.push(sum(1, 2, undefined, 3), sum(1, null, 2, 3), sum(1, true, 2, 3));
try {
	sum(1, 2n, 3, 4);
} catch (error) {
	outputs.push(error.constructor.name);
}
outputs.push(
	mixed(3, 4, 5),
	mixed(3, "4", 5),
	mixed(-0, 0, -0),
	mixed(2, traced("m", 6), 1),
);
outputs.push(events.join(","));

function captureFusion(invoke) {
	try {
		return show(invoke());
	} catch (error) {
		return error.constructor.name;
	}
}

const fusionCases = [
	primitiveFusionStart,
	primitiveFusionFinish,
	primitiveFusionLink,
	primitiveFusionStringStart,
	primitiveFusionStringLink,
	primitiveFusionStringFinish,
	primitiveFusionStringCompare,
	primitiveFusionReverseCompare,
	primitiveFusionStrict,
	primitiveFusionLoose,
];
const fusionInputs = [
	[1, 2, 3],
	[-0, -0, -0],
	[NaN, 2, 3],
	[Infinity, -Infinity, 2],
	["1", 2, "3"],
	[1, "2", undefined],
	[null, true, false],
	[undefined, 2, null],
	[1n, 2n, 3n],
	[1, 2n, 3],
	[Symbol("left"), 2, 3],
	[1, 2, Symbol("other")],
	[traced("left", 1), traced("right", 2), traced("other", 3)],
	[traced("text", "1"), 2, traced("tail", 3)],
	[
		{
			valueOf() {
				events.push("throw");
				collectGarbage();
				throw new RangeError("coercion");
			},
		},
		2,
		3,
	],
];
for (const kernel of fusionCases)
	for (const flag of [false, true])
		for (const [left, right, other] of fusionInputs)
			outputs.push(captureFusion(() => kernel(left, right, flag, other)));
for (const flag of [false, true])
	for (const [left, right, other] of fusionInputs) {
		outputs.push(
			captureFusion(() => {
				const iterator = resumablePrimitiveFusion(left, right, flag, other);
				iterator.next();
				collectGarbage();
				return iterator.next().value;
			}),
		);
		for (const symbol of [false, true])
			outputs.push(
				captureFusion(() => primitiveFusionManaged(left, right, flag, other, symbol)),
			);
	}
for (const [left, right, other] of fusionInputs)
	outputs.push(captureFusion(() => primitiveFusionPartial(left, right, other, ":")));
outputs.push(events.join(","));
console.log(outputs.map(show).join(" "));
