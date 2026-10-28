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
const transitiveRecord = function transitiveRecord(value, limit, hook) {
	for (let i = 0; i < 3; i++) hook();
	const n = value >>> 0;
	const bound = limit >>> 0;
	if (n < bound) {
		hook(n);
		if (bound < 16) return { n };
	}
	return { n: 0 };
};
function readTransitiveRecords(value, limit, hook) {
	let sum = 0;
	for (let i = 0; i < 4; i++) {
		const record = transitiveRecord(value + i, limit, hook);
		sum += record.n % 16;
	}
	return sum;
}
function chainedRecord(value, middleInput, limit) {
	const n = value >>> 0;
	const middle = middleInput >>> 0;
	const bound = limit & 255;
	if (n < middle && middle < bound && bound < 16) return { n };
	return { n: 0 };
}
function equalBoundRecord(value, limit) {
	const n = value >>> 0;
	const bound = limit >>> 0;
	if (n <= bound && bound <= n && bound < 16) return { n };
	return { n: 0 };
}
function opaqueLaterBound(value, limit) {
	const n = value >>> 0;
	if (n < limit && limit < 16) return { n };
	return { n: 0 };
}
for (const value of [0, 1, 13, 14, 15, 16, 2147483648, 4294967295]) {
	for (const limit of [0, 1, 15, 16, 255, 4294967295]) {
		let expected = 0;
		for (let i = 0; i < 4; i++) {
			const n = (value + i) >>> 0;
			if (n < limit >>> 0 && limit >>> 0 < 16) expected += n;
		}
		check(
			"later guard narrows returned fields",
			readTransitiveRecords(value, limit, () => {}) === expected,
		);
		const n = value >>> 0;
		check(
			"cyclic nonstrict comparisons retain equality",
			equalBoundRecord(value, limit).n === (n === limit >>> 0 && n < 16 ? n : 0),
		);
		check(
			"transitive strict comparisons retain both endpoints",
			chainedRecord(value, limit, 15).n === (n < limit >>> 0 && limit >>> 0 < 15 ? n : 0),
		);
	}
}
const observations = [];
transitiveRecord(2147483648, 4294967295, (value) => {
	if (value !== undefined) observations.push(value);
});
check(
	"earlier wide observation is not narrowed by a later guard",
	observations[0] === 2147483648,
);
let limitConversions = 0;
const changingBound = {
	valueOf() {
		return limitConversions++ === 0 ? Infinity : 7;
	},
};
check(
	"coercive bounds do not acquire transitive integer facts",
	opaqueLaterBound(4294967295, changingBound).n === 4294967295,
);
check("both coercive comparisons remain observable", limitConversions === 2);

function signedRemainders(value) {
	const n = value | 0;
	if (n > -16 && n < 16)
		return [n % 16, n % -16, n % 15.5, n % -15.5, n % Infinity, n % -Infinity];
	return [];
}
for (const value of [-15, -1, 0, 1, 15])
	for (const result of signedRemainders(value))
		check("signed bounded remainders retain their dividend", Object.is(result, value));
function endpointRemainder(value) {
	const n = value | 0;
	if (n >= -16 && n <= 16) return n % -16;
	return 99;
}
check(
	"positive dividend endpoint produces positive zero",
	Object.is(endpointRemainder(16), 0),
);
check(
	"negative dividend endpoint produces negative zero",
	Object.is(endpointRemainder(-16), -0),
);
for (const divisor of [0, -0, NaN])
	check("invalid remainder divisor retains NaN", Number.isNaN(7 % divisor));
function negativeDivisor(hook) {
	for (let i = 0; i < 3; i++) hook();
	return -16;
}
function effectfulIdentityRemainder(value, hook) {
	const n = value | 0;
	if (n > -16 && n < 16) return n % negativeDivisor(hook);
	return 99;
}
let divisorCalls = 0;
check(
	"identity remainder keeps a negative dividend",
	effectfulIdentityRemainder(-7, () => divisorCalls++) === -7,
);
check("identity remainder keeps divisor producer effects", divisorCalls === 3);

function* suspendedTransitive(value, limit) {
	const n = value >>> 0;
	const bound = limit >>> 0;
	if (n < bound) {
		yield 0;
		if (bound < 16) return { n };
	}
	return { n: 0 };
}
const suspended = suspendedTransitive(7, 15);
check("transitive generator suspends", suspended.next().value === 0);
check("transitive generator returns the bounded field", suspended.next().value.n === 7);
async function asyncTransitive(value, limit) {
	const record = transitiveRecord(value, limit, () => {});
	await 0;
	return record.n % 16;
}
async function* asyncGeneratorTransitive(value, limit) {
	const record = transitiveRecord(value, limit, () => {});
	yield 0;
	await 0;
	return record.n % 16;
}
async function checkAsyncTransitive() {
	check("async bounded field survives suspension", (await asyncTransitive(7, 15)) === 7);
	const iterator = asyncGeneratorTransitive(7, 15);
	check("async generator suspends", (await iterator.next()).value === 0);
	const result = await iterator.next();
	check("async generator returns the bounded field", result.done && result.value === 7);
	console.log("numeric-branch-ranges PASS");
}
checkAsyncTransitive();
