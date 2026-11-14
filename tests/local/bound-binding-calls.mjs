// Calls of module and captured bindings that hold Function.prototype.bind results:
// warm loops, rebinding to other receivers and arguments, construction, call and
// apply through the bound function, bound functions bound again and throwing targets.
const results = [];
function record(label, value) {
	results.push(`${label}=${value}`);
}

function receiverCall(prefix, value) {
	return prefix + value + this.offset;
}
function describeThis(value) {
	return `${typeof this}:${String(this)}:${value}`;
}
function sum3(first, second, third) {
	return first * 100 + second * 10 + third;
}
function countArguments() {
	return `${arguments.length}:${[...arguments].join(",")}`;
}
function thrower(code, value) {
	if (value % 7 === 3) throw new RangeError(`boom ${code} ${value}`);
	return code + value;
}
function Point(x, y) {
	this.x = x;
	this.y = y;
}
Point.prototype.sum = function () {
	return this.x * 10 + this.y;
};

const receiver = { offset: 11 };
const other = { offset: 1000 };
const bound = receiverCall.bind(receiver, 5);

function hot(rounds) {
	let total = 0;
	for (let index = 0; index < rounds; index++) total += bound(index & 1023);
	return total;
}

// Every caller reaches the loop through this, so it stays one site.
const runners = [hot];
const loops = 40;
const rounds = 64;
let warm = 0;
for (let round = 0; round < loops; round++) warm += runners[0](rounds);
record("warm", warm);
record("loops", loops);
record("rounds", rounds);
record("metadata", `${bound.name}/${bound.length}`);

const unbound = describeThis.bind(undefined);
const boundNull = describeThis.bind(null);
const boundNumber = describeThis.bind(5);
const boundString = describeThis.bind("text");
const boundObject = describeThis.bind(other);
function receivers(rounds) {
	const seen = new Set();
	for (let index = 0; index < rounds; index++) {
		seen.add(unbound(index & 1));
		seen.add(boundNull(index & 1));
		seen.add(boundNumber(index & 1));
		seen.add(boundString(index & 1));
		seen.add(boundObject(index & 1));
	}
	return [...seen].join("|");
}
record("receivers", receivers(8));

const boundPair = sum3.bind(null, 1, 2);
const boundTriple = sum3.bind(null, 4, 5, 6);
const boundCount = countArguments.bind(null, "a", "b");
function argumentCounts(rounds) {
	let total = 0;
	let counts = "";
	for (let index = 0; index < rounds; index++) {
		total += boundPair(index) + boundTriple(index, index);
		counts = boundCount(index, index + 1, index + 2);
	}
	return `${total}/${counts}/${boundCount()}`;
}
record("arguments", argumentCounts(16));

let rebound = receiverCall.bind(receiver, 5);
function rebind(self, prefix) {
	rebound = receiverCall.bind(self, prefix);
}
function rebinding(rounds) {
	let total = 0;
	for (let index = 0; index < rounds; index++) {
		if (index === rounds >> 1) rebind(other, 7);
		total += rebound(index);
	}
	return total;
}
record("rebinding", rebinding(32));
rebind(receiver, 5);
record("restored", rebinding(32));

function makeCaller(self, prefix) {
	const local = receiverCall.bind(self, prefix);
	return (value) => local(value);
}
const callers = [
	makeCaller(receiver, 1),
	makeCaller(other, 2),
	makeCaller({ offset: -5 }, 3),
];
function captured(rounds) {
	let total = 0;
	for (let index = 0; index < rounds; index++) total += callers[index % 3](index);
	return total;
}
record("captured", captured(30));

const BoundPoint = Point.bind(null, 3);
function construction(rounds) {
	let total = 0;
	let failures = 0;
	for (let index = 0; index < rounds; index++) {
		const point = new BoundPoint(index);
		total +=
			point.sum() +
			(point instanceof Point ? 1 : 0) +
			(point instanceof BoundPoint ? 1 : 0);
		try {
			BoundPoint(index);
		} catch (error) {
			if (error instanceof TypeError) failures++;
		}
	}
	return `${total}/${failures}`;
}
record("construction", construction(8));

function forwarded(rounds) {
	let total = 0;
	for (let index = 0; index < rounds; index++)
		total +=
			bound.call(other, index) +
			bound.apply(other, [index]) +
			Reflect.apply(bound, other, [index]);
	return total;
}
record("forwarded", forwarded(16));

const twice = bound.bind(other, 9);
const twiceLater = twice.bind(null);
function boundAgain(rounds) {
	let total = 0;
	for (let index = 0; index < rounds; index++) total += twice(index) + twiceLater(index);
	return `${total}/${twice.name}/${twice.length}/${twiceLater.name}`;
}
record("bound-again", boundAgain(8));

const boundThrower = thrower.bind(null, 42);
function throwing(rounds) {
	let total = 0;
	const messages = [];
	for (let index = 0; index < rounds; index++) {
		try {
			total += boundThrower(index);
		} catch (error) {
			messages.push(`${error.name}:${error.message}`);
		}
	}
	return `${total}/${messages.join(",")}`;
}
record("throwing", throwing(20));

console.log(results.join("\n"));
