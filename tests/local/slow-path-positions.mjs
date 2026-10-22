// Operations whose numeric fast path cannot throw publish their source position
// only on the slow path. A throw from that path must still report its own line.
const thrower = {
	valueOf() {
		throw new Error("coerced");
	},
};

function line(name, action) {
	try {
		action();
		return "none";
	} catch (error) {
		const frame = error.stack.split("\n").find((text) => text.includes(`at ${name} `));
		return frame?.match(/:(\d+):\d+\)?$/)?.[1] ?? "?";
	}
}

function compare(left, right) {
	return left < right;
}

function add(left, right) {
	return left + right;
}

function before() {
	const result = value * 2;
	let value = 1;
	return result;
}

const results = [];
for (let round = 0; round < 3; round++) {
	results.push([
		compare(1, 2),
		add(1, 2),
		line("compare", () => compare(1, thrower)),
		line("add", () => add(thrower, 1)),
		line("before", before),
	]);
}
console.log(JSON.stringify(results));
