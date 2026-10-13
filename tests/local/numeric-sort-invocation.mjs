function collect() {
	globalThis.__mal_collect_garbage?.();
}

function snapshot(a, b) {
	return arguments.length === 2 ? arguments[0] - arguments[1] : 1000 + arguments.length;
}

function missing(a, b, extra) {
	if (extra !== undefined) throw new Error("unexpected third comparator argument");
	return a - b;
}

function defaults(a, b, extra = 7) {
	if (extra !== 7) throw new Error("comparator default parameter was skipped");
	return a - b;
}

function rest(a, ...remaining) {
	if (remaining.length !== 1) throw new Error("wrong comparator rest length");
	collect();
	return a - remaining[0];
}

function noFormals() {
	return arguments[0] - arguments[1];
}

function sortSnapshot(receiver) {
	return receiver.sort(snapshot);
}

const observations = [];
for (const Type of [Array, Float64Array]) {
	const input = Type === Array ? [7, 2, 5] : new Type([7, 2, 5]);
	observations.push(Array.from(sortSnapshot(input)));
	observations.push(Array.from(input.toSorted(missing)));
	observations.push(Array.from(input.toSorted(defaults)));
	observations.push(Array.from(input.sort(rest)));
	observations.push(Array.from(input.toSorted(noFormals)));
}

observations.push(sortSnapshot({ sort: (callback) => callback(7, 2, 100) }));
const sparse = [4, , undefined, 1];
observations.push(sparse.toSorted(snapshot).join(","));
sparse.sort(snapshot);
observations.push(sparse.join(","), Object.keys(sparse).join(","));

let coerced = 0;
const mixed = [
	4,
	"2",
	{
		valueOf() {
			collect();
			coerced++;
			return 3;
		},
	},
	1,
];
observations.push(sortSnapshot(mixed).map(Number), coerced > 0);

function runCaptured(input) {
	const records = [];
	let scale = 1;
	let first = true;
	let nested;
	function capture(a, b) {
		let current = a;
		const read = () => current;
		records.push({ read, expected: a - b });
		collect();
		if (first) {
			first = false;
			nested = new Float64Array([8, 3, 6]).sort(snapshot).join(",");
			input[0] = 99;
			scale = {
				valueOf() {
					collect();
					return 1;
				},
			};
		}
		current = (a - b) * scale;
		return current;
	}
	const sorted = input.sort(capture);
	collect();
	if (!records.every(({ read, expected }) => read() === expected)) {
		throw new Error("comparator activation capture changed");
	}
	if (new Set(records.map(({ read }) => read)).size !== records.length) {
		throw new Error("comparator closure identity reused");
	}
	return [Array.from(sorted), nested, records.length > 0];
}

observations.push(runCaptured([4, 3, 2, 1]));
observations.push(runCaptured(new Float64Array([4, 3, 2, 1])));

function runThrow() {
	let calls = 0;
	let retained;
	const marker = {};
	function throwing(a, b) {
		calls++;
		retained = () => a - b;
		collect();
		if (calls > 0) throw marker;
		return 0;
	}
	const input = [3, 2, 1];
	try {
		input.sort(throwing);
	} catch (error) {
		collect();
		return [error === marker, calls === 1, typeof retained() === "number", input];
	}
	throw new Error("comparator exception was lost");
}

observations.push(runThrow());
observations.push(sortSnapshot([5, 1, 3]));
console.log(JSON.stringify(observations));
