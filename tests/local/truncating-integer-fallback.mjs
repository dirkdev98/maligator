function probe(x, y, next) {
	return (x + y) | next();
}
globalThis.probe = probe;
const results = [];
const order = [];
const marker = {};
function coercing(name, value) {
	return {
		valueOf() {
			order.push(name);
			return value;
		},
	};
}
for (const [x, y, z] of [
	[2147483647, 2147483647, 0],
	[-2147483648, -2147483648, 1],
	[1.75, 1.75, 0],
	[1e40, -1, 0],
	[NaN, 3, 0],
	[Infinity, 0, 0],
	[-0, -0, 0],
	["3", "4", 0],
	[coercing("x", "3"), coercing("y", 4), coercing("z", 0)],
	[2147483647, 1, coercing("z", 1.5)],
	[1n, 2n, 3n],
	[1n, 2, 0],
	[1, 2, Symbol()],
	[
		{
			valueOf() {
				throw marker;
			},
		},
		1,
		0,
	],
]) {
	order.length = 0;
	try {
		results.push(
			String(
				globalThis.probe(x, y, () => {
					order.push("next");
					const garbage = Array.from({ length: 32 }, (_, index) => ({ index }));
					if (garbage.length !== 32) throw marker;
					return z;
				}),
			),
		);
	} catch (error) {
		results.push(error === marker ? "marker" : error.constructor.name);
	}
	results.push(order.join(","));
}
console.log(JSON.stringify(results));
