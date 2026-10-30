// Restarting must preserve the original arguments and never replay JavaScript effects.
const log = [];

function flagsOf(type) {
	return type.flags & 7 ? type.objectFlags : 0;
}

function idOf(node) {
	return node.id;
}

function compare(a, b) {
	return a === b ? 0 : a === undefined ? -1 : b === undefined ? 1 : a < b ? -1 : 1;
}

function sum(a, b) {
	return a + b;
}

function loose(a, b) {
	return [a == b, a != b];
}

function bits(a, b) {
	return [a & b, a | b, a ^ b, a << b, a >> b, a >>> b, ~a];
}

function arithmetic(a, b) {
	return [a - b, a * b, a / b, a % b, -a, +a];
}

function positiveRemainder(input, other) {
	return (input >>> 0) % ((other & 255) + 1);
}

globalThis.positiveRemainder = positiveRemainder;
for (const input of [
	0,
	-0,
	-1,
	255,
	2147483648,
	4294967295,
	4294967296,
	NaN,
	Infinity,
	"17",
	7n,
	Symbol("input"),
]) {
	for (const other of [0, -1, 1, 255, "7", 7n]) {
		try {
			const result = positiveRemainder(input, other);
			log.push(`positive remainder ${Object.is(result, -0) ? "-0" : result}`);
		} catch (error) {
			log.push(`positive remainder ${error.name}`);
		}
	}
}

function kind(value) {
	return typeof value === "string"
		? "string"
		: typeof value === "function"
			? "function"
			: "other";
}

function defaulted(value, fallback = 10) {
	return value ?? fallback;
}

function Point(x) {
	this.x = x;
}
Point.prototype.getX = function () {
	return this.x;
};

function receiverKind() {
	return this === undefined ? "undefined" : typeof this;
}

function readLate() {
	return late;
}

const counter = { value: 0 };
function readCounter() {
	return counter.value;
}

let moduleScore = 1;
function readModuleScore() {
	return moduleScore;
}

function isLarge(n) {
	return n > 10;
}

// Callees large enough to stay calls, so one fast body reaches another.
function kindOf(node) {
	const kind = node.kind;
	if (kind === 1) return node.a + node.b;
	if (kind === 2) return node.a - node.b;
	if (kind === 3) return node.a * node.b;
	if (kind === 4) return node.a / node.b;
	if (kind === 5) return node.a % node.b;
	return node.a === node.b ? 0 : -1;
}

function sumKinds(left, right) {
	return kindOf(left) + kindOf(right);
}

function last(stack) {
	return stack[stack.length - 1];
}

function at(items, index) {
	return items[index];
}

function lengthOf(value) {
	return value.length;
}

const shapes = [];
for (let i = 0; i < 8; i++) {
	const type = { flags: i, objectFlags: i * 10 };
	type[`extra${i}`] = i;
	shapes.push(type);
}
const getterType = {
	flags: 1,
	get objectFlags() {
		log.push("objectFlags getter");
		return 99;
	},
};
const proxyType = new Proxy(
	{ flags: 3, objectFlags: 30 },
	{
		get(target, key) {
			log.push(`proxy get ${String(key)}`);
			return target[key];
		},
	},
);

let total = 0;
for (let round = 0; round < 2000; round++) {
	for (const type of shapes) total += flagsOf(type);
}
log.push(`flags total ${total}`);
log.push(`getter flags ${flagsOf(getterType)}`);
log.push(`proxy flags ${flagsOf(proxyType)}`);
log.push(`string flags ${flagsOf("text")}`);
log.push(`inherited flags ${flagsOf(Object.create({ flags: 5, objectFlags: 50 }))}`);
for (const receiver of [null, undefined]) {
	try {
		flagsOf(receiver);
	} catch (error) {
		log.push(`${String(receiver)} receiver ${error.constructor.name}`);
	}
}

let lengths = 0;
for (let round = 0; round < 1000; round++)
	lengths += lengthOf(round % 2 ? [1, 2] : "abc");
log.push(
	`lengths ${lengths} ${lengthOf({ length: 7 })} ${lengthOf(new Uint8Array(4))} ${lengthOf(function (a, b) {})}`,
);
log.push(
	`wide flags ${flagsOf({ flags: -8, objectFlags: 1 })} ${flagsOf({ flags: 2 ** 32 + 1, objectFlags: 2 })}`,
);
for (let round = 0; round < 1000; round++) total += idOf({ id: round });
log.push(`ids ${total} ${idOf("abc")} ${idOf([1, 2])}`);

const valued = {
	valueOf() {
		log.push("valueOf");
		return 5;
	},
};
log.push(
	`compare ${[compare(1, 2), compare(2, 1), compare(3, 3), compare(undefined, 1), compare(1, undefined)]}`,
);
log.push(`compare strings ${[compare("a", "b"), compare("b", "a"), compare("a", "a")]}`);
log.push(`compare objects ${compare(valued, 6)} ${compare(NaN, NaN)} ${compare(-0, 0)}`);
log.push(
	`sum ${[sum(1, 2), sum(0.1, 0.2), sum(2 ** 31, 2 ** 31), sum("a", 1), sum(1n, 2n), sum(valued, 1)]}`,
);
log.push(`sum -0 ${Object.is(sum(-0, -0), -0)}`);
log.push(
	`loose ${loose(1, 1)} ${loose(null, undefined)} ${loose(0, null)} ${loose("1", 1)} ${loose(valued, 5)}`,
);
log.push(
	`bits ${bits(5, 3)} ${bits(2 ** 32 + 5, 33)} ${bits(-1.5, 1)} ${bits(valued, 1)}`,
);
log.push(
	`arithmetic ${arithmetic(7, 2)} ${arithmetic(-7, 2)} ${Object.is(arithmetic(-4, 2)[3], -0)} ${arithmetic(1, 0)}`,
);
log.push(`arithmetic mixed ${arithmetic("8", 2)} ${arithmetic(valued, 2)}`);
log.push(`kinds ${[kind("x"), kind(() => 1), kind(1), kind(null)]}`);
log.push(
	`defaults ${[defaulted(1), defaulted(undefined), defaulted(null, 2), defaulted(0)]}`,
);

const point = new Point(4);
let xs = 0;
for (let round = 0; round < 1000; round++) xs += point.getX();
log.push(`point ${xs} ${Point.prototype.getX.call({ x: "other" })}`);
const constructed = new Point.prototype.getX();
log.push(
	`constructed ${typeof constructed} ${constructed instanceof Point.prototype.getX}`,
);
log.push(`receivers ${receiverKind()} ${receiverKind.call(1)} ${receiverKind.call("s")}`);

try {
	readLate();
} catch (error) {
	log.push(`late ${error.constructor.name}`);
}
let late = "ready";
log.push(`late ${readLate()}`);

for (let round = 0; round < 5; round++) {
	counter.value = round;
	moduleScore = round * 2;
	log.push(`captured ${readCounter()} ${readModuleScore()}`);
}

let large = 0;
for (let n = 0; n < 40; n++) if (isLarge(n)) large++;
log.push(`large ${large} ${isLarge("11")} ${isLarge(11n)}`);

let kinds = 0;
const kindNodes = [1, 2, 3, 4, 5, 6].map((kind) => ({ kind, a: kind * 3, b: 2 }));
for (let round = 0; round < 3000; round++)
	kinds += sumKinds(kindNodes[round % 6], kindNodes[(round + 1) % 6]);
const lazyNode = {
	kind: 1,
	get a() {
		log.push("node getter");
		return 5;
	},
	b: 1,
};
const valuedNode = { kind: 1, a: valued, b: 1 };
log.push(
	`kinds ${kinds} ${sumKinds(kindNodes[0], lazyNode)} ${sumKinds(valuedNode, kindNodes[1])}`,
);
try {
	sumKinds(kindNodes[0], null);
} catch (error) {
	log.push(`kinds null ${error.constructor.name}`);
}

let lastTotal = 0;
const stacks = [[1, 2, 3], [4], [5, 6]];
for (let round = 0; round < 3000; round++) lastTotal += last(stacks[round % 3]);
const holey = [1, , 3];
const indexed = [0, 1];
Object.defineProperty(indexed, 1, {
	get() {
		log.push("index getter");
		return 9;
	},
});
const proxied = new Proxy([7, 8], {
	get(target, key) {
		log.push(`proxy index ${String(key)}`);
		return target[key];
	},
});
log.push(`last ${lastTotal} ${last([])} ${last("abc")} ${last(new Int8Array([4, 5]))}`);
log.push(
	`at ${[at([1, 2], 1), at([1, 2], 2), at([1, 2], -1), at([1, 2], 0.5), at([1, 2], "1")]}`,
);
log.push(
	`at holes ${at(holey, 1)} ${at(indexed, 1)} ${at(proxied, 0)} ${at({ 0: "object" }, 0)}`,
);
Array.prototype[5] = "inherited";
log.push(`at inherited ${at([1], 5)}`);
delete Array.prototype[5];

function columnMath(values, index) {
	const value = values[index];
	return value * 2 + value / 3;
}
globalThis.columnMath = columnMath;
for (const values of [
	[6],
	[1.5],
	[-0],
	[NaN],
	[Infinity],
	["6"],
	[undefined],
	holey,
	indexed,
	proxied,
])
	log.push(`column ${columnMath(values, values.length > 1 ? 1 : 0)}`);
const growingColumn = [3];
log.push(`column grow ${columnMath(growingColumn, 0)}`);
growingColumn.push(7.5);
growingColumn[0] = "9";
log.push(
	`column widened ${columnMath(growingColumn, 0)} ${columnMath(growingColumn, 1)} ${columnMath(growingColumn, 9)}`,
);
Array.prototype[5] = 12;
log.push(`column inherited ${columnMath([1], 5)}`);
delete Array.prototype[5];

function indexedSign(values, index) {
	const value = values[index];
	return value === undefined ? false : Object.is(index, -0);
}
globalThis.indexedSign = indexedSign;
log.push(`column signs ${indexedSign([3], 0)} ${indexedSign([3], -0)}`);
const fractionalColumn = [2];
Object.defineProperty(fractionalColumn, "1.5", {
	get() {
		log.push("fractional column getter");
		return 7;
	},
});
log.push(
	`column keys ${columnMath(fractionalColumn, 1.5)} ${columnMath([3], "0")} ${columnMath({ 2147483648: 9 }, 2147483648)}`,
);

function branchEffect(flag, node, callback) {
	const first = node.value;
	if (flag) return first + 1;
	node = callback(node);
	return first + node.value;
}

function branchConversion(flag, value) {
	if (flag) return value === null;
	return -value;
}

function branchStore(flag, node) {
	if (flag) return node.value;
	node.value += 1;
	return node.value;
}

globalThis.branchEffect = branchEffect;
globalThis.branchConversion = branchConversion;
globalThis.branchStore = branchStore;
const changed = { value: 4 };
const callback = (node) => {
	log.push(`callback ${node.value}`);
	if (typeof globalThis.gc === "function") globalThis.gc();
	return { value: node.value + 10 };
};
for (const flag of [true, false, true, false]) {
	log.push(`branch ${globalThis.branchEffect(flag, changed, callback)}`);
	log.push(`store ${globalThis.branchStore(flag, changed)} ${changed.value}`);
}
const getterNode = {
	get value() {
		log.push("branch getter");
		return 5;
	},
};
log.push(`branch getter result ${globalThis.branchEffect(false, getterNode, callback)}`);
try {
	globalThis.branchEffect(false, changed, () => {
		log.push("throwing callback");
		throw new RangeError("callback");
	});
} catch (error) {
	log.push(`branch throw ${error.name}`);
}
for (const value of [true, false, null, undefined, 0, -0, 1n, "4", valued, Symbol("s")]) {
	log.push(`convert branch ${globalThis.branchConversion(true, value)}`);
	try {
		const result = globalThis.branchConversion(false, value);
		log.push(`convert result ${String(result)} ${Object.is(result, -0)}`);
	} catch (error) {
		log.push(`convert throw ${error.name}`);
	}
}

const primitiveBinary = {
	add(value, right, flag) {
		const left = flag ? (value ? true : null) : "2";
		return left + right;
	},
	subtract(value, right, flag) {
		const left = flag ? (value ? true : null) : "2";
		return left - right;
	},
	multiply(value, right, flag) {
		const left = flag ? (value ? true : null) : "2";
		return left * right;
	},
	divide(value, right, flag) {
		const left = flag ? (value ? true : null) : "2";
		return left / right;
	},
	remainder(value, right, flag) {
		const left = flag ? (value ? true : null) : "2";
		return left % right;
	},
	power(value, right, flag) {
		const left = flag ? (value ? true : null) : "2";
		return left ** right;
	},
	and(value, right, flag) {
		const left = flag ? (value ? true : null) : "2";
		return left & right;
	},
	or(value, right, flag) {
		const left = flag ? (value ? true : null) : "2";
		return left | right;
	},
	xor(value, right, flag) {
		const left = flag ? (value ? true : null) : "2";
		return left ^ right;
	},
	shiftLeft(value, right, flag) {
		const left = flag ? (value ? true : null) : "2";
		return left << right;
	},
	shiftRight(value, right, flag) {
		const left = flag ? (value ? true : null) : "2";
		return left >> right;
	},
	shiftUnsigned(value, right, flag) {
		const left = flag ? (value ? true : null) : "2";
		return left >>> right;
	},
	less(value, right, flag) {
		const left = flag ? (value ? true : null) : "2";
		return left < right;
	},
	lessEqual(value, right, flag) {
		const left = flag ? (value ? true : null) : "2";
		return left <= right;
	},
	greater(value, right, flag) {
		const left = flag ? (value ? true : null) : "2";
		return left > right;
	},
	greaterEqual(value, right, flag) {
		const left = flag ? (value ? true : null) : "2";
		return left >= right;
	},
};
globalThis.primitiveBinary = primitiveBinary;

function framedPrimitiveBinary(operator, value, right, flag, gate) {
	gate();
	const left = flag ? (value ? true : null) : "2";
	switch (operator) {
		case "add":
			return left + right;
		case "subtract":
			return left - right;
		case "multiply":
			return left * right;
		case "divide":
			return left / right;
		case "remainder":
			return left % right;
		case "power":
			return left ** right;
		case "and":
			return left & right;
		case "or":
			return left | right;
		case "xor":
			return left ^ right;
		case "shiftLeft":
			return left << right;
		case "shiftRight":
			return left >> right;
		case "shiftUnsigned":
			return left >>> right;
		case "less":
			return left < right;
		case "lessEqual":
			return left <= right;
		case "greater":
			return left > right;
		case "greaterEqual":
			return left >= right;
	}
}

function* resumedPrimitiveBinary(operator, value, right, flag) {
	const left = flag ? (value ? true : null) : "2";
	yield left;
	switch (operator) {
		case "add":
			return left + right;
		case "subtract":
			return left - right;
		case "multiply":
			return left * right;
		case "divide":
			return left / right;
		case "remainder":
			return left % right;
		case "power":
			return left ** right;
		case "and":
			return left & right;
		case "or":
			return left | right;
		case "xor":
			return left ^ right;
		case "shiftLeft":
			return left << right;
		case "shiftRight":
			return left >> right;
		case "shiftUnsigned":
			return left >>> right;
		case "less":
			return left < right;
		case "lessEqual":
			return left <= right;
		case "greater":
			return left > right;
		case "greaterEqual":
			return left >= right;
	}
}

globalThis.framedPrimitiveBinary = framedPrimitiveBinary;
globalThis.resumedPrimitiveBinary = resumedPrimitiveBinary;
const binaryFrameGate = () => log.push("binary frame");
const coercionThrows = {
	[Symbol.toPrimitive](hint) {
		log.push(`binary coercion throw ${hint}`);
		throw new RangeError("binary coercion");
	},
};
const primitiveOperands = [
	0,
	-0,
	1,
	-1,
	2 ** 32 + 1,
	33.5,
	NaN,
	Infinity,
	-Infinity,
	true,
	false,
	null,
	undefined,
	"2",
	2n,
	valued,
	coercionThrows,
	Symbol("binary"),
];
for (const operation of Object.keys(primitiveBinary)) {
	for (const flag of [true, false]) {
		for (const value of [true, false]) {
			for (const right of primitiveOperands) {
				for (const mode of ["fast", "full", "resume"]) {
					try {
						let result;
						if (mode === "fast")
							result = globalThis.primitiveBinary[operation](value, right, flag);
						else if (mode === "full")
							result = globalThis.framedPrimitiveBinary(
								operation,
								value,
								right,
								flag,
								binaryFrameGate,
							);
						else {
							const coroutine = globalThis.resumedPrimitiveBinary(
								operation,
								value,
								right,
								flag,
							);
							const yielded = coroutine.next();
							log.push(`binary yielded ${yielded.done} ${String(yielded.value)}`);
							const finished = coroutine.next();
							log.push(`binary finished ${finished.done}`);
							result = finished.value;
						}
						log.push(
							`binary ${mode} ${operation} ${flag} ${value} ${String(result)} ${Object.is(result, -0)}`,
						);
					} catch (error) {
						log.push(`binary ${mode} ${operation} ${flag} ${value} ${error.name}`);
					}
				}
			}
		}
	}
}

function textDifference(value, right) {
	if (typeof value !== "string") return undefined;
	return value - right;
}

function scalarPower(base, exponent) {
	return base ** exponent;
}

globalThis.textDifference = textDifference;
globalThis.scalarPower = scalarPower;
for (const text of [
	"",
	" ",
	"0x10",
	"-0",
	"\u2028 2 \u2029",
	"2e3",
	"bad",
	"Infinity",
	"0b10",
	"1_0",
	"0\0",
]) {
	for (const right of [-0, 2, "3", valued, Symbol("text")]) {
		try {
			const result = globalThis.textDifference(text, right);
			log.push(`text difference ${String(result)} ${Object.is(result, -0)}`);
		} catch (error) {
			log.push(`text difference ${error.name}`);
		}
	}
}
for (const [base, exponent] of [
	[-0, -3],
	[-0, 3],
	[1, Infinity],
	[-1, -Infinity],
	[NaN, 0],
	[NaN, 1],
	[2, undefined],
	[2, null],
	[2, "3"],
	["-0", -3],
	[valued, 2],
	[2, valued],
	[2n, 3n],
	[2n, 1],
	[Symbol("power"), 2],
]) {
	try {
		const result = globalThis.scalarPower(base, exponent);
		log.push(`scalar power ${String(result)} ${Object.is(result, -0)}`);
	} catch (error) {
		log.push(`scalar power ${error.name}`);
	}
}

function additionChoice(flag, right) {
	const left = flag ? true : "2";
	return left + right;
}

function comparisonChoice(flag, right) {
	const left = flag ? true : "2";
	return left < right;
}

function primitiveComparison(left, right) {
	if (typeof left !== "string" && typeof left !== "boolean") return null;
	if (typeof right !== "string" && typeof right !== "number") return undefined;
	return left <= right;
}

function additionChoices(first, second, value) {
	const left = first ? true : "2";
	const right = second ? !!value : "11";
	return left + right;
}

function comparisonChoices(first, second, value) {
	const left = first ? (value ? true : null) : "2";
	const right = second ? +value : "11";
	return left <= right;
}

globalThis.additionChoice = additionChoice;
globalThis.comparisonChoice = comparisonChoice;
globalThis.primitiveComparison = primitiveComparison;
globalThis.additionChoices = additionChoices;
globalThis.comparisonChoices = comparisonChoices;
for (const right of [
	3,
	"11",
	"3",
	NaN,
	false,
	null,
	undefined,
	valued,
	Symbol("choice"),
]) {
	for (const flag of [true, false]) {
		for (const operation of ["additionChoice", "comparisonChoice"]) {
			try {
				log.push(
					`choice ${operation} ${flag} ${String(globalThis[operation](flag, right))}`,
				);
			} catch (error) {
				log.push(`choice ${operation} ${flag} ${error.name}`);
			}
		}
	}
}
for (const left of [true, false, "2", "bad", null, valued]) {
	for (const right of [0, 2, NaN, "11", "2", "bad", undefined]) {
		log.push(`primitive compare ${String(globalThis.primitiveComparison(left, right))}`);
	}
}

for (const first of [true, false]) {
	for (const second of [true, false]) {
		for (const value of [0, 2, 12, NaN, "3", valued, Symbol("choices")]) {
			for (const operation of ["additionChoices", "comparisonChoices"]) {
				try {
					log.push(
						`choices ${operation} ${first} ${second} ${String(globalThis[operation](first, second, value))}`,
					);
				} catch (error) {
					log.push(`choices ${operation} ${first} ${second} ${error.name}`);
				}
			}
		}
	}
}

function mathRound(value) {
	if (value === null) return "nil";
	return Math.round(value);
}
function mathInterval(value) {
	if (value === null) return "nil";
	return Math.floor(value & 255) % 10;
}
function mathMinimum(value, other) {
	if (value === null) return "nil";
	return Math.min(value, other);
}
function mathNumbers(value, other) {
	return Math.imul(value, other) + Math.clz32(value);
}
function mathHypot(value, other) {
	return Math.hypot(value, other, 2);
}
function mathPower(value, other) {
	return Math.pow(value, other);
}
function mathThenCoerce(value, other) {
	return Math.round(value) - other;
}
function mathExtraArgument(value, extra) {
	return Math.round(value, extra());
}
function mathMissing() {
	return Math.pow();
}
function numberFinite(value) {
	return Number.isFinite(value);
}
function numberInteger(value) {
	return Number.isInteger(value);
}
function numberSafeInteger(value) {
	return Number.isSafeInteger(value);
}
function numberNaN(value) {
	return Number.isNaN(value);
}
Object.assign(globalThis, {
	mathRound,
	mathInterval,
	mathMinimum,
	mathNumbers,
	mathHypot,
	mathPower,
	mathThenCoerce,
	mathExtraArgument,
	mathMissing,
	numberFinite,
	numberInteger,
	numberSafeInteger,
	numberNaN,
});
for (const value of [
	-0,
	-0.5,
	0.5,
	-10,
	255,
	2147483648,
	4294967295,
	NaN,
	Infinity,
	-Infinity,
	true,
	"7",
	"bad",
	null,
	undefined,
	valued,
	1n,
	Symbol("Math"),
]) {
	for (const name of [
		"mathRound",
		"mathInterval",
		"mathMinimum",
		"mathNumbers",
		"mathHypot",
		"mathPower",
		"mathThenCoerce",
		"numberFinite",
		"numberInteger",
		"numberSafeInteger",
		"numberNaN",
	]) {
		try {
			const result = globalThis[name](value, -2);
			// Hypot permits implementation-approximated finite results.
			const shown =
				name === "mathHypot" && Number.isFinite(result) ? result.toPrecision(12) : result;
			log.push(`${name} ${Object.is(result, -0) ? "-0" : shown}`);
		} catch (error) {
			log.push(`${name} ${error.name}`);
		}
	}
}
log.push(
	`math replay ${globalThis.mathThenCoerce(1.5, valued)} ${globalThis.mathThenCoerce(valued, valued)}`,
);
log.push(
	`math extra ${globalThis.mathExtraArgument(1.5, () => {
		log.push("math extra argument");
		return valued;
	})}`,
);
log.push(`math missing ${globalThis.mathMissing()}`);
const revokedNumberInput = Proxy.revocable({}, {});
revokedNumberInput.revoke();
log.push(`number proxy ${globalThis.numberInteger(revokedNumberInput.proxy)}`);
if (Object.getOwnPropertyDescriptor(Number, "isInteger").writable) {
	const original = Number.isInteger;
	try {
		Number.isInteger = () => ({ label: "patched predicate" });
		log.push(globalThis.numberInteger(1).label);
	} finally {
		Number.isInteger = original;
	}
	log.push(`number restored ${globalThis.numberInteger(1)}`);
}

function collectionGet(collection, key) {
	return collection.get(key);
}
function collectionHas(collection, key) {
	return collection.has(key);
}
function readCollectionThenFallback(collection, key, value) {
	return collection.get(key) + value;
}
globalThis.collectionGet = collectionGet;
globalThis.collectionHas = collectionHas;
globalThis.readCollectionThenFallback = readCollectionThenFallback;
const collectionKey = {
	toString() {
		throw new Error("must not coerce map keys");
	},
};
const map = new Map([
	[collectionKey, 1],
	[NaN, 2],
	[-0, 3],
	["x", 4],
]);
const set = new Set([collectionKey, NaN, -0, "x"]);
const weakMap = new WeakMap([[collectionKey, 5]]);
const weakSet = new WeakSet([collectionKey]);
for (const collection of [map, set, weakMap, weakSet]) {
	for (const key of [collectionKey, {}, NaN, -0, "x", undefined]) {
		log.push(`collection has ${collectionHas(collection, key)}`);
		if (collection instanceof Map || collection instanceof WeakMap)
			log.push(`collection get ${collectionGet(collection, key)}`);
	}
}
map.set(collectionKey, 9);
log.push(`collection mutation ${collectionGet(map, collectionKey)}`);
log.push(`collection missing ${collectionGet(map)}`);
const fallbackCoercion = {
	[Symbol.toPrimitive]() {
		log.push("collection coercion");
		return 7;
	},
};
log.push(
	`collection fallback ${readCollectionThenFallback(map, collectionKey, fallbackCoercion)}`,
);
for (const receiver of [
	new Proxy(map, {}),
	{ get: Map.prototype.get, has: Set.prototype.has },
	{
		get(key) {
			log.push(`override get ${key}`);
			return 12;
		},
		has(key) {
			log.push(`override has ${key}`);
			return false;
		},
	},
	{
		get get() {
			log.push("get getter");
			return () => 13;
		},
		get has() {
			log.push("has getter");
			return () => true;
		},
	},
	{
		get() {
			throw new Error("collection throw");
		},
		has() {
			throw new Error("collection throw");
		},
	},
]) {
	for (const operation of [collectionGet, collectionHas]) {
		try {
			log.push(`collection seam ${operation(receiver, "x")}`);
		} catch (error) {
			log.push(`collection seam ${error.name}`);
		}
	}
}
map.get = function () {
	log.push("map override");
	return 14;
};
log.push(`collection overridden ${collectionGet(map, collectionKey)}`);
if (globalThis.gc) globalThis.gc();
console.log(log.join("\n"));
