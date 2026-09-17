let passed = 0;

function check(condition, label) {
	if (!condition) throw new Error(`rest-index-scalarization: ${label}`);
	passed++;
}

function read(first, ...rest) {
	return rest[2] + rest[0] + rest[2] + first;
}

function missing(...rest) {
	return rest[4];
}

function churn(seed) {
	let value = seed;
	for (let index = 0; index < 40; index++) value = { value, index };
	return value;
}

function delayed(...rest) {
	const noise = churn(1);
	return rest[0].value + rest[2].value + (noise.index === 39 ? 0 : 1000);
}

function defaulted(first = churn(2), ...rest) {
	return rest[0].value + (first.index === 39 ? 0 : 1000);
}

function mutated(first, ...rest) {
	first = 99;
	return rest[0];
}

function exactInline(value) {
	function read(first = churn(2), ...rest) {
		first = 99;
		const noise = churn(1);
		return rest[0].value + rest[2] + (noise.index === 39 ? 0 : 1000);
	}
	return read(undefined, value, 3, 5);
}

function exactMissingInline(value) {
	function read(...rest) {
		return rest[3];
	}
	return read(value);
}

function count(...rest) {
	return rest.length + (rest[0] ?? 0);
}

check(read(1, 2, 3, 4) === 11, "constant reads preserve rest indexing");
check(missing(1, 2) === undefined, "missing argument reads as undefined");
check(
	delayed({ value: 11 }, { value: 13 }, { value: 17 }) === 28,
	"argument snapshots retain objects across safepoints",
);
check(
	defaulted(undefined, { value: 19 }) === 19,
	"default evaluation preserves later argument snapshots",
);
check(mutated(1, 23) === 23, "parameter mutation does not alter rest snapshots");
check(
	exactInline({ value: 29 }) === 34,
	"exact inlining preserves defaults, mutation, and rooted snapshots",
);
check(exactMissingInline(31) === undefined, "exact inlining preserves missing snapshots");
check(count() === 0, "empty rest length uses the argument count");
check(count(41, 43) === 43, "rest length and element share argument snapshots");

console.log(`rest-index-scalarization PASS ${passed}`);
