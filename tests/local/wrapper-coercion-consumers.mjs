function check(condition, message) {
	if (!condition) throw new Error(message);
}
function typeError(run) {
	let error;
	try {
		run();
	} catch (caught) {
		error = caught;
	}
	check(error instanceof TypeError, "expected TypeError");
}
function numberOperators(value, other) {
	const wrapper = new Number(value);
	return [
		+wrapper,
		-wrapper,
		~wrapper,
		wrapper + other,
		wrapper - other,
		wrapper * other,
		wrapper / other,
		wrapper % other,
		wrapper ** other,
		wrapper & other,
		wrapper | other,
		wrapper ^ other,
		wrapper << other,
		wrapper >> other,
		wrapper >>> other,
		wrapper < other,
		wrapper <= other,
		wrapper > other,
		wrapper >= other,
	];
}
function booleanOperators(value, other) {
	const wrapper = new Boolean(value);
	return [
		+wrapper,
		-wrapper,
		~wrapper,
		wrapper + other,
		wrapper - other,
		wrapper * other,
		wrapper / other,
		wrapper % other,
		wrapper ** other,
		wrapper & other,
		wrapper | other,
		wrapper ^ other,
		wrapper << other,
		wrapper >> other,
		wrapper >>> other,
		wrapper < other,
		wrapper <= other,
		wrapper > other,
		wrapper >= other,
	];
}
function stringOperators(value, other) {
	const wrapper = new String(value);
	return [
		+wrapper,
		-wrapper,
		~wrapper,
		wrapper + other,
		wrapper - other,
		wrapper * other,
		wrapper / other,
		wrapper % other,
		wrapper ** other,
		wrapper & other,
		wrapper | other,
		wrapper ^ other,
		wrapper << other,
		wrapper >> other,
		wrapper >>> other,
		wrapper < other,
		wrapper <= other,
		wrapper > other,
		wrapper >= other,
	];
}
function bigintOperators(value) {
	const wrapper = Object(BigInt(value));
	return [
		-wrapper,
		~wrapper,
		wrapper + 2n,
		wrapper - 2n,
		wrapper * 2n,
		wrapper / 2n,
		wrapper % 2n,
		wrapper ** 2n,
		wrapper & 2n,
		wrapper | 2n,
		wrapper ^ 2n,
		wrapper << 2n,
		wrapper >> 2n,
		wrapper < 2n,
		wrapper <= 2n,
		wrapper > 2n,
		wrapper >= 2n,
	];
}
function numberConversion(value) {
	return Number(new Number(value));
}
function booleanConversion(value) {
	return Number(new Boolean(value));
}
function textConversion(value) {
	return Number(new String(value));
}
function boxedBigintConversion(value) {
	return Number(Object(BigInt(value)));
}
function numberText(value) {
	return String(new Number(value));
}
function booleanText(value) {
	return String(new Boolean(value));
}
function bigintText(value) {
	return String(Object(BigInt(value)));
}
function numberBigint(value) {
	return BigInt(new Number(value));
}
function booleanBigint(value) {
	return BigInt(new Boolean(value));
}
function textBigint(value) {
	return BigInt(new String(value));
}
function boxedBigint(value) {
	return BigInt(Object(BigInt(value)));
}
function wrappedTruth(value) {
	return Boolean(new Number(value));
}
function finite(value) {
	return isFinite(new Number(value));
}
function nan(value) {
	return isNaN(new String(value));
}
function symbolText() {
	return String(Object(Symbol.iterator));
}
function symbolNumber() {
	return Number(Object(Symbol.iterator));
}
function symbolBigint() {
	return BigInt(Object(Symbol.iterator));
}
function bigintPlus() {
	return +Object(1n);
}
function bigintUnsigned() {
	return Object(1n) >>> 1n;
}
function mixedNumeric() {
	return Object(1n) + 1;
}
const results = [];
for (const value of [
	undefined,
	null,
	false,
	true,
	0,
	-0,
	1.5,
	-3,
	NaN,
	Infinity,
	-Infinity,
	"7",
	"bad",
	3n,
]) {
	for (const probe of [numberOperators, booleanOperators, stringOperators])
		results.push(probe(value, 2));
	results.push(
		numberConversion(value),
		booleanConversion(value),
		textConversion(value),
		numberText(value),
		booleanText(value),
		wrappedTruth(value),
		finite(value),
		nan(value),
	);
}
for (const value of [-17, -1, 0, 1, 3, 127])
	results.push(
		bigintOperators(value),
		boxedBigintConversion(value),
		bigintText(value),
		numberBigint(value),
		booleanBigint(value),
		textBigint(value),
		boxedBigint(value),
	);
for (const probe of [
	symbolText,
	symbolNumber,
	symbolBigint,
	bigintPlus,
	bigintUnsigned,
	mixedNumeric,
])
	typeError(probe);
for (const probe of [
	numberOperators,
	stringOperators,
	numberConversion,
	textConversion,
	numberText,
	numberBigint,
	textBigint,
])
	typeError(() => probe(Symbol.iterator, 2));
const events = [];
const input = {
	[Symbol.toPrimitive](hint) {
		events.push("input:" + hint);
		return 7;
	},
};
const other = {
	[Symbol.toPrimitive](hint) {
		events.push("other:" + hint);
		return 3;
	},
};
function ordered(value, right) {
	return new Number(value) + right();
}
check(
	ordered(input, () => {
		events.push("right");
		return other;
	}) === 10,
	"ordered arithmetic",
);
check(
	events.join(",") === "input:number,right,other:default",
	"constructor conversion before right expression and operand coercion",
);
events.length = 0;
function rightWrapper(left, value) {
	return left() + new Number(value);
}
check(
	rightWrapper(() => {
		events.push("left");
		return other;
	}, input) === 10,
	"right wrapper arithmetic",
);
check(
	events.join(",") === "left,input:number,other:default",
	"both operand expressions precede binary coercion",
);
events.length = 0;
function withExtra(value, extra) {
	return Number(new Number(value), extra());
}
check(
	withExtra(input, () => events.push("extra")) === 7 &&
		events.join(",") === "input:number,extra",
	"conversion calls retain extra argument effects",
);
function symbolWithExtra(value, extra) {
	return String(Object(Symbol(value)), extra());
}
events.length = 0;
typeError(() => symbolWithExtra(input, () => events.push("extra")));
check(
	events.join(",") === "input:string,extra",
	"Symbol description and extra arguments precede the wrapper ToString error",
);
check(
	String(Symbol.iterator) === "Symbol(Symbol.iterator)" &&
		Object(Symbol.iterator).toString() === "Symbol(Symbol.iterator)",
	"explicit Symbol conversions still return descriptive strings",
);
const marker = {};
const poison = {
	[Symbol.toPrimitive]() {
		throw marker;
	},
};
events.length = 0;
let caught;
try {
	ordered(poison, () => events.push("right"));
} catch (error) {
	caught = error;
}
check(
	caught === marker && events.length === 0,
	"constructor exception wins before right expression",
);
function compare(value, other) {
	return new Number(value) < other;
}
events.length = 0;
check(
	compare(input, other) === false && events.join(",") === "input:number,other:number",
	"relational coercion order",
);
function tagged(value) {
	return `${new Number(value)}`;
}
check(tagged(-0) === "0" && tagged(3) === "3", "template ToString");
function increment(value) {
	let wrapper = new Number(value);
	return ++wrapper;
}
function decrement(value) {
	let wrapper = Object(BigInt(value));
	return --wrapper;
}
check(increment(4) === 5 && decrement(4) === 3n, "numeric update of local binding");
let observed;
function escaping(value) {
	const wrapper = new Number(value);
	observed = wrapper;
	return +wrapper;
}
check(
	escaping(5) === 5 && typeof observed === "object" && observed.valueOf() === 5,
	"escaping wrapper identity",
);
const first = observed;
escaping(5);
check(first !== observed, "fresh escaping wrappers");
function mutated(value) {
	const wrapper = new Number(value);
	wrapper[Symbol.toPrimitive] = () => 99;
	return +wrapper;
}
check(mutated(5) === 99, "own coercion override");
function exposed(value, callback) {
	const wrapper = new Number(value);
	return wrapper + callback(wrapper);
}
check(
	exposed(5, (wrapper) => {
		wrapper[Symbol.toPrimitive] = () => 11;
		return 2;
	}) === 13,
	"operand callback can mutate an exposed wrapper",
);
function loose(value) {
	return new Number(value) == value;
}
events.length = 0;
check(
	loose(input) === false && events.join(",") === "input:number",
	"object equality must not become primitive equality",
);
if (!Object.isFrozen(Number)) {
	const descriptor = Object.getOwnPropertyDescriptor(Number.prototype, "valueOf");
	try {
		Number.prototype.valueOf = function () {
			return 41;
		};
		check(numberConversion(5) === 41, "mutable prototype coercion");
	} finally {
		Object.defineProperty(Number.prototype, "valueOf", descriptor);
	}
	const saved = Number;
	try {
		globalThis.Number = function (value) {
			return {
				valueOf() {
					return value + 100;
				},
			};
		};
		check(+new Number(5) === 105, "replaced constructor coercion");
	} finally {
		globalThis.Number = saved;
	}
}
function encode(value) {
	if (Array.isArray(value)) return "[" + value.map(encode).join(",") + "]";
	if (typeof value === "number") return Object.is(value, -0) ? "-0" : String(value);
	if (typeof value === "bigint") return value + "n";
	return typeof value + ":" + String(value);
}
console.log(results.map(encode).join("|"));
console.log("wrapper coercion consumers passed");
