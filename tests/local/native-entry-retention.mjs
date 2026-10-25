const results = [];
let coercions = 0;

function collect() {
	if (typeof globalThis.gc === "function") globalThis.gc();
}

function makeVisitor(seed) {
	const producer = function producer(x, bias) {
		return (
			x +
			bias +
			0 +
			(x + bias + 1) +
			(x + bias + 2) +
			(x + bias + 3) +
			(x + bias + 4) +
			(x + bias + 5) +
			(x + bias + 6) +
			(x + bias + 7) +
			(x + bias + 8) +
			(x + bias + 9) +
			(x + bias + 10) +
			(x + bias + 11) +
			(x + bias + 12) +
			(x + bias + 13) +
			(x + bias + 14) +
			(x + bias + 15) +
			(x + bias + 16) +
			(x + bias + 17) +
			(x + bias + 18) +
			(x + bias + 19) +
			(x + bias + 20) +
			(x + bias + 21) +
			(x + bias + 22) +
			(x + bias + 23)
		);
	};
	const stringPath = function stringPath(x, bias) {
		return (
			x +
			bias +
			23 +
			(x + bias + 22) +
			(x + bias + 21) +
			(x + bias + 20) +
			(x + bias + 19) +
			(x + bias + 18) +
			(x + bias + 17) +
			(x + bias + 16) +
			(x + bias + 15) +
			(x + bias + 14) +
			(x + bias + 13) +
			(x + bias + 12) +
			(x + bias + 11) +
			(x + bias + 10) +
			(x + bias + 9) +
			(x + bias + 8) +
			(x + bias + 7) +
			(x + bias + 6) +
			(x + bias + 5) +
			(x + bias + 4) +
			(x + bias + 3) +
			(x + bias + 2) +
			(x + bias + 1) +
			(x + bias + 0)
		);
	};
	const numberPath = function numberPath(value, bias) {
		return value * 2 + bias * 3;
	};
	const visitor = function visitor(x, bias) {
		const value = producer(x, bias);
		if (typeof value === "string") return stringPath(x, bias);
		return numberPath(value, bias);
	};
	const compacted = function compacted(x, bias) {
		const value = producer(x, bias);
		if (typeof value === "string") return stringPath(x, bias);
		return stringPath("ready", bias);
	};
	globalThis.visitor = visitor;
	globalThis.compacted = compacted;
	let total = 0;
	let lengths = 0;
	for (let i = 0; i < 100; i++) {
		total += visitor(i, seed);
		lengths += compacted(i, seed).length;
	}
	results.push(total, lengths);
	return visitor;
}

const visit = makeVisitor(4);
for (const [x, bias] of [
	[1, 4],
	[-0, -0],
	[NaN, 1],
	[Infinity, 2],
	[-Infinity, 2],
	["x", 3],
	[3, "b"],
	["", ""],
	[undefined, 3],
	[null, 4],
	[true, 4],
	[17n, 4],
	[Symbol.for("x"), 4],
	[
		{
			[Symbol.toPrimitive]() {
				coercions++;
				collect();
				return coercions % 2 ? "x" : 3;
			},
		},
		4,
	],
	[
		3,
		{
			[Symbol.toPrimitive]() {
				coercions++;
				collect();
				return "b";
			},
		},
	],
]) {
	for (const fn of [visit, globalThis.compacted]) {
		try {
			const value = fn(x, bias);
			results.push(
				typeof value === "number" && Object.is(value, -0) ? "-0" : String(value),
			);
		} catch (error) {
			results.push(error.name);
		}
	}
}
results.push(coercions);
console.log(results.join("|"));
