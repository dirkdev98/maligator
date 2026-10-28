function check(name, condition) {
	if (!condition) throw new Error(`FAIL ${name}`);
}

function consequentBounds(value) {
	const index = value | 0;
	if (index >= 0 && index < 16) return index % 16;
	return 99;
}

function alternateBounds(value) {
	const index = value | 0;
	if (index < 0) return 99;
	if (index >= 16) return 99;
	return index % 16;
}

function coerciveBounds(value) {
	if (value >= 0 && value < 16) return value % 16;
	return 99;
}

function consequentLoop() {
	let total = 0;
	for (let index = 0; index < 32; index++) {
		if (index < 16) total += index % 16;
	}
	return total;
}

function alternateLoop() {
	let total = 0;
	for (let index = 0; index < 32; index++) {
		if (index >= 16) continue;
		total += index % 16;
	}
	return total;
}

check("consequent lower endpoint", consequentBounds(0) === 0);
check("consequent upper endpoint", consequentBounds(15) === 15);
check("consequent rejects negative", consequentBounds(-1) === 99);
check("consequent rejects upper", consequentBounds(16) === 99);
check("alternate lower endpoint", alternateBounds(0) === 0);
check("alternate upper endpoint", alternateBounds(15) === 15);
check("alternate rejects negative", alternateBounds(-1) === 99);
check("alternate rejects upper", alternateBounds(16) === 99);
check("fraction remains fractional", coerciveBounds(3.5) === 3.5);
check("NaN remains rejected", coerciveBounds(NaN) === 99);
check("infinity remains rejected", coerciveBounds(Infinity) === 99);
check("negative zero survives remainder", Object.is(coerciveBounds(-0), -0));
check("consequent loop branch", consequentLoop() === 120);
check("alternate loop branch", alternateLoop() === 120);

let coercions = 0;
const coercive = {
	valueOf() {
		coercions++;
		return 7.5;
	},
};
check("boxed comparisons remain coercive", coerciveBounds(coercive) === 7.5);
check("boxed coercion count", coercions === 3);

function relationalRecord(value, limit, hook) {
	const number = value >>> 0;
	const bound = limit & 255;
	const record = { number: 0 };
	if (number < bound) record.number = number;
	hook();
	return record;
}

function readRelationalRecord(value, limit, hook) {
	const record = relationalRecord(value, limit, hook);
	hook();
	return record.number | 0;
}

function opaqueRelationalRecord(value, bound) {
	const number = value >>> 0;
	if (number < bound) return { number };
	return { number: 0 };
}

for (const value of [-0, 0, 1, 254, 255, 256, -1, 4294967295, NaN, Infinity]) {
	for (const limit of [-0, 0, 1, 15, 255, 256, -1, NaN]) {
		const number = value >>> 0;
		const expected = number < (limit & 255) ? number : 0;
		let calls = 0;
		check(
			"variable-bound record field",
			readRelationalRecord(value, limit, () => calls++) === expected,
		);
		check("variable-bound callbacks execute", calls === 2);
	}
}
const events = [];
check(
	"variable-bound record coercion result",
	readRelationalRecord(
		{
			valueOf() {
				events.push("value");
				return 7;
			},
		},
		{
			valueOf() {
				events.push("bound");
				return 15;
			},
		},
		() => events.push("hook"),
	) === 7,
);
check("variable-bound coercion order", events.join(",") === "value,bound,hook,hook");
for (const bound of [Infinity, 4294967296n, { valueOf: () => Infinity }])
	check(
		"opaque bound retains a wide integer field",
		opaqueRelationalRecord(4294967295, bound).number === 4294967295,
	);
for (const bound of [NaN, -0, -Infinity])
	check(
		"opaque non-comparable and lower bounds",
		opaqueRelationalRecord(1, bound).number === 0,
	);
const failure = {};
try {
	readRelationalRecord(
		{
			valueOf() {
				throw failure;
			},
		},
		{
			valueOf() {
				throw new Error("bound coerced after subject failure");
			},
		},
		() => {
			throw new Error("callback ran after subject failure");
		},
	);
	throw new Error("missing subject failure");
} catch (error) {
	check("subject exception identity", error === failure);
}
for (const bound of [Symbol("limit"), 1n]) {
	let error;
	try {
		readRelationalRecord(1, bound, () => {
			throw new Error("callback ran after bound failure");
		});
	} catch (caught) {
		error = caught;
	}
	check("bound coercion remains abrupt", error instanceof TypeError);
}
console.log("numeric-branch-ranges PASS");
