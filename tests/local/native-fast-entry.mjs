// Small read-only functions take a frameless entry that restarts in the full entry
// whenever a load misses or an operand is not a Number. Every case below forces a
// restart at a different point and checks that nothing observable ran twice.
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

console.log(log.join("\n"));
