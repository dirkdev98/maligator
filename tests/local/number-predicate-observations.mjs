const events = [];
function collect() {
	if (typeof globalThis.gc === "function") globalThis.gc();
}
function finiteText(input, flag, extra) {
	const value = flag ? String(input) : null;
	if (Number.isFinite(value, extra())) return input + 1;
	return false;
}
function integerSymbol(input, flag, extra) {
	const value = flag ? Symbol(input) : false;
	if (Number.isInteger(value, extra())) return input + 1;
	return false;
}
function safeBigInt(input, flag, extra) {
	const value = flag ? BigInt(input) : undefined;
	if (Number.isSafeInteger(value, extra())) return input + 1;
	return false;
}
function nanText(input, flag, extra) {
	const value = flag ? String(input) : null;
	if (Number.isNaN(value, extra())) return input + 1;
	return false;
}
function finiteInt32(input, extra) {
	const value = input | 0;
	if (Number.isFinite(value, extra())) return true;
	return input + 1;
}
function integerUint32(input, extra) {
	const value = input >>> 0;
	if (Number.isInteger(value, extra())) return true;
	return input + 1;
}
function safeInt32(input, extra) {
	const value = input | 0;
	if (Number.isSafeInteger(value, extra())) return true;
	return input + 1;
}
function nanInt32(input, extra) {
	const value = input | 0;
	if (Number.isNaN(value, extra())) return input + 1;
	return false;
}
function loopRange() {
	let sum = 0;
	for (let i = 0; i < 100; i++) {
		if (
			Number.isFinite(i) &&
			Number.isInteger(i) &&
			Number.isSafeInteger(i) &&
			!Number.isNaN(i)
		)
			sum += i;
		else sum += globalThis.unexpectedPredicateBranch();
	}
	return sum;
}
function unknownNumber(input) {
	const value = +input;
	return [
		Number.isFinite(value),
		Number.isInteger(value),
		Number.isSafeInteger(value),
		Number.isNaN(value),
	].join(",");
}
function directNonNumber(value) {
	return [
		Number.isFinite(value),
		Number.isInteger(value),
		Number.isSafeInteger(value),
		Number.isNaN(value),
	].join(",");
}
globalThis.observeUnknownNumber = unknownNumber;
globalThis.observeNonNumber = directNonNumber;
function run(label, fn) {
	try {
		events.push(`${label}:${String(fn())}`);
	} catch (error) {
		events.push(`${label}:${error.name}`);
	}
}
const input = {
	[Symbol.toPrimitive](hint) {
		events.push(`coerce:${hint}`);
		collect();
		return "7";
	},
};
const throwing = {
	[Symbol.toPrimitive]() {
		events.push("coerce:throw");
		collect();
		throw new RangeError("conversion");
	},
};
const cases = [
	["isFinite", finiteText],
	["isInteger", integerSymbol],
	["isSafeInteger", safeBigInt],
	["isNaN", nanText],
];
for (const [name, fn] of cases) {
	for (const flag of [false, true]) {
		for (const value of [
			input,
			throwing,
			undefined,
			null,
			true,
			-0,
			NaN,
			1n,
			Symbol("s"),
		])
			run(`${name}:${flag}`, () =>
				fn(value, flag, () => {
					events.push("extra");
					collect();
				}),
			);
		run(`${name}:extra-throw`, () =>
			fn(input, flag, () => {
				events.push("extra:throw");
				collect();
				throw new SyntaxError("extra");
			}),
		);
	}
}
for (const fn of [finiteInt32, integerUint32, safeInt32, nanInt32])
	for (const value of [
		input,
		throwing,
		Symbol("s"),
		1n,
		-0,
		NaN,
		Infinity,
		-Infinity,
		0.5,
		Number.MAX_SAFE_INTEGER,
		4294967295,
	])
		run("integer-proof", () =>
			fn(value, () => {
				events.push("integer-extra");
				collect();
			}),
		);
run("loop-range", loopRange);
for (const value of [
	-0,
	NaN,
	Infinity,
	-Infinity,
	0.5,
	-1.5,
	Number.MAX_SAFE_INTEGER,
	-Number.MAX_SAFE_INTEGER,
	9007199254740992,
	Number.MIN_VALUE,
	Number.MAX_VALUE,
	input,
	throwing,
])
	run("unknown-number", () => unknownNumber(value));
const revoked = Proxy.revocable({}, {});
revoked.revoke();
for (const value of [
	undefined,
	null,
	true,
	"7",
	1n,
	Symbol("s"),
	throwing,
	new Number(NaN),
	revoked.proxy,
])
	run("non-number", () => directNonNumber(value));
run("construct", () => new Number.isInteger(+input));
run("spread", () =>
	Number.isFinite(
		...{
			[Symbol.iterator]() {
				events.push("iterator");
				collect();
				return {
					next() {
						throw new URIError("spread");
					},
				};
			},
		},
	),
);
if (Object.getOwnPropertyDescriptor(Number, "isFinite").writable) {
	for (const [name, fn] of cases) {
		const original = Number[name];
		try {
			run(`${name}:callee-before-extra`, () =>
				fn(input, true, () => {
					events.push("replace");
					Number[name] = function () {
						collect();
						return {};
					};
				}),
			);
			run(`${name}:replacement`, () =>
				fn(input, false, () => {
					events.push("replacement-extra");
					collect();
				}),
			);
		} finally {
			Number[name] = original;
		}
	}
}
console.log(events.join("\n"));
