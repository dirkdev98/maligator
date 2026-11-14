// Numeric loops calling module bindings that hold Function.prototype.bind results. The
// loop's entry checks the bound function and reads its target, this and arguments, so
// these cases change those between loops, or make the entry decline: rebinding to
// another receiver or argument, before and in the middle of a loop, an argument that is
// no integer or no Number, an accessor, a missing, inherited or throwing read, a
// throwing target, construction, a binding still in its dead zone, and holes and
// strings among the iterated values.
const results = [];
function record(label, value) {
	results.push(`${label}=${value}`);
}

function receiverCall(prefix, value) {
	return prefix + value + this.offset;
}
function masked(mask, value) {
	return (value & mask) + this.offset;
}
function guarded(limit, value) {
	if (value > limit) throw new RangeError(`above ${limit}: ${value}`);
	return value + limit;
}

const receiver = { offset: 11 };
const other = { offset: 1000 };
let reads = 0;
const accessor = {
	get offset() {
		reads++;
		return 3;
	},
};
const bound = receiverCall.bind(receiver, 5);
let rebound = receiverCall.bind(receiver, 5);
const maskBound = masked.bind(other, 15);
const guardBound = guarded.bind(null, 40);

function warm(rounds) {
	let total = 0;
	for (let index = 0; index < rounds; index++) total += bound(index & 1023);
	return total;
}
function reboundSum(rounds) {
	let total = 0;
	for (let index = 0; index < rounds; index++) total += rebound(index & 1023);
	return total;
}
function maskedValues(values) {
	let total = 0;
	for (const value of values) total = (total + maskBound(value)) | 0;
	return total;
}
function maskedIndexed(values) {
	let total = 0;
	for (let index = 0; index < values.length; index++) total += maskBound(values[index]);
	return total;
}
function guardedSum(rounds) {
	let total = 0;
	for (let index = 0; index < rounds; index++) total += guardBound(index);
	return total;
}

// Every caller reaches the loops through these, so each stays one site.
const runners = [warm, reboundSum, maskedValues];
const loops = 40;
const rounds = 64;
const numbers = Array.from({ length: rounds }, (_, index) => index * 7);
let total = 0;
for (let round = 0; round < loops; round++)
	total += runners[0](rounds) + runners[1](rounds) + runners[2](numbers);
record("warm", total);
record("loops", loops);
record("rounds", rounds);

rebound = receiverCall.bind(other, 7);
record("other-receiver", reboundSum(16));
rebound = receiverCall.bind(receiver, -5);
record("other-argument", reboundSum(16));
rebound = receiverCall.bind(receiver, "x");
record("string-argument", reboundSum(4));
rebound = receiverCall.bind(receiver, 1.5);
record("fractional-argument", reboundSum(16));
rebound = receiverCall.bind(accessor, 5);
record("accessor", `${reboundSum(16)}/${reads}`);
rebound = receiverCall.bind({}, 5);
record("missing", reboundSum(4));
rebound = receiverCall.bind(Object.create(other), 5);
record("inherited", reboundSum(16));
rebound = receiverCall.bind({ offset: 2 ** 52 }, 5);
record("large", reboundSum(16));
rebound = receiverCall.bind(null, 5);
try {
	record("null-receiver", reboundSum(4));
} catch (error) {
	record("null-receiver", error.constructor.name);
}
rebound = receiverCall.bind(receiver, 5);
record("restored", reboundSum(16));

function midLoop(rounds) {
	let sum = 0;
	for (let index = 0; index < rounds; index++) {
		if (index === rounds >> 1) rebound = receiverCall.bind(other, 9);
		sum += rebound(index);
	}
	return sum;
}
record("mid-loop", midLoop(16));
rebound = receiverCall.bind(receiver, 5);

const constructed = new rebound(4);
record(
	"construct",
	`${constructed instanceof receiverCall}/${Object.keys(constructed).length}/${reboundSum(8)}`,
);

try {
	record("guarded", guardedSum(64));
} catch (error) {
	record("guarded", `${error.constructor.name}:${error.message}`);
}
record("guarded-short", guardedSum(32));

const holes = numbers.slice();
delete holes[0];
delete holes[20];
const mixed = numbers.map((value, index) => (index % 9 === 4 ? `${value}` : value));
record("holes", `${maskedValues(holes)}/${maskedIndexed(holes)}`);
record("mixed", `${maskedValues(mixed)}/${maskedIndexed(mixed)}`);

function early(rounds) {
	let sum = 0;
	for (let index = 0; index < rounds; index++) sum += late(index);
	return sum;
}
try {
	record("dead-zone", early(4));
} catch (error) {
	record("dead-zone", error.constructor.name);
}
const late = masked.bind(receiver, 3);
record("initialized", early(16));

console.log(results.join("\n"));
