const MOD = 1_000_000_007;
const collectGarbage = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});
const events = [];

function sum(total, a, b, c) {
	return (total + a + b + c) % MOD;
}

function mixed(total, a, b) {
	return total * a - b / 2 + a;
}

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
console.log(outputs.map(show).join(" "));
