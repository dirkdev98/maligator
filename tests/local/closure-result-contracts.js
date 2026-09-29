function check(label, actual, expected) {
	if (actual !== expected) throw new Error(label + ": " + actual + " !== " + expected);
}

function makeResultFamily(initial) {
	let bias = initial;
	const leaf = function resultOnlyLeaf(input) {
		const x = +input;
		return (
			x * 1 +
			x * 2 +
			x * 3 +
			x * 4 +
			x * 5 +
			x * 6 +
			x * 7 +
			x * 8 +
			x * 9 +
			x * 10 +
			x * 11 +
			x * 12 +
			x * 13 +
			x * 14 +
			x * 15 +
			x * 16 +
			x * 17 +
			x * 18 +
			x * 19 +
			x * 20 +
			x * 21 +
			x * 22 +
			x * 23 +
			x * 24 +
			x * 25 +
			x * 26 +
			x * 27 +
			x * 28 +
			x * 29 +
			x * 30 +
			x * 31 +
			x * 32 +
			x * 33 +
			x * 34 +
			x * 35 +
			x * 36 +
			x * 37 +
			x * 38 +
			x * 39 +
			x * 40 +
			x * 41 +
			x * 42 +
			x * 43 +
			x * 44 +
			x * 45 +
			x * 46 +
			x * 47 +
			x * 48 +
			+bias
		);
	};
	const visit = function resultOnlyVisitor(offset, input) {
		let sum = offset;
		for (let step = 0; step < 3; step++) sum += leaf(input);
		return sum;
	};
	return { visit, leaf, write: (next) => (bias = next) };
}

const family = makeResultFamily(3);
const independent = makeResultFamily(13);
globalThis.resultOnlyVisitor = family.visit;
globalThis.resultOnlyLeaf = family.leaf;
for (let i = 0; i < 16; i++) {
	family.write(i & 3);
	const input = { valueOf: () => i };
	check(
		"boxed input and scalar result",
		family.visit(i, input),
		i + 3 * (1176 * i + (i & 3)),
	);
}
check(
	"same code retains independent state",
	independent.visit(1, "2"),
	1 + 3 * (2352 + 13),
);
check("private result ABI preserves public arity", family.leaf.length, 1);

let coercions = 0;
check(
	"coercion updates the shared capture before its read",
	family.visit(5, {
		valueOf() {
			family.write(++coercions);
			return 2;
		},
	}),
	5 + 3 * 2352 + 6,
);
check("coercion occurs once per leaf call", coercions, 3);
const failure = new Error("result-only coercion failure");
let threw = false;
try {
	family.visit(0, {
		valueOf() {
			family.write("9");
			throw failure;
		},
	});
} catch (error) {
	threw = error === failure;
}
check("throw crosses the result-only call boundary", threw, true);
check("throw preserves the reentrant capture store", family.visit(0, 0), 27);
check("generic apply keeps numeric behavior", family.visit.apply(null, [3, "2"]), 7086);
check(
	"canonical entry keeps string behavior",
	family.visit.apply(null, ["x", "2"]),
	"x236123612361",
);
const missing = family.visit(0);
check("missing boxed input preserves NaN", missing !== missing, true);
console.log("closure-result-contracts PASS");
