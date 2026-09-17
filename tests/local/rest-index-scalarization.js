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

function chooseBounded(selector, ...rest) {
	return rest[(+selector) & 1];
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
check(chooseBounded(0, 47, 53, 59, 61) === 47, "bounded read selects zero");
check(chooseBounded(1, 47, 53, 59, 61) === 53, "bounded read selects one");
check(chooseBounded(1, 67) === undefined, "bounded read preserves missing arguments");
check(
	chooseBounded(1, 71, undefined) === undefined,
	"bounded read preserves explicit undefined",
);
const objectPayload = { value: 73 };
const symbolPayload = Symbol("rest-index-scalarization");
check(chooseBounded(0, objectPayload, 79) === objectPayload, "bounded read preserves objects");
check(chooseBounded(1, 83, 89n) === 89n, "bounded read preserves bigints");
check(chooseBounded(1, 97, symbolPayload) === symbolPayload, "bounded read preserves symbols");
let coercions = 0;
const coerciveSelector = {
	valueOf() {
		coercions++;
		churn(101);
		return 1;
	},
};
check(
	chooseBounded(coerciveSelector, 103, objectPayload) === objectPayload,
	"bounded read roots payloads across coercion",
);
check(coercions === 1, "bounded read coerces its key once");
const thrown = { value: 107 };
let caught;
try {
	chooseBounded(
		{
			valueOf() {
				throw thrown;
			},
		},
		109,
		113,
	);
} catch (error) {
	caught = error;
}
check(caught === thrown, "bounded read preserves coercion throws");

console.log(`rest-index-scalarization PASS ${passed}`);
