// Breaks and returns out of Array for-of loops while %ArrayIteratorPrototype%.return
// is installed before a loop, from inside one, and removed again. Each close must call
// the method exactly when, and as often as, the specification's IteratorClose does.
const ArrayIteratorPrototype = Object.getPrototypeOf([][Symbol.iterator]());
const log = [];

function findAbove(values, limit) {
	for (const value of values) if (value > limit) return value;
	return -1;
}

function sumUntil(values, limit) {
	let total = 0;
	for (const value of values) {
		if (value > limit) break;
		total += value;
	}
	return total;
}

function rowsInnerBreak(rows, limit) {
	let total = 0;
	for (const row of rows) {
		for (const value of row) {
			if (value > limit) break;
			total += value;
		}
	}
	return total;
}

function installReturn(label, result = {}) {
	ArrayIteratorPrototype.return = function () {
		log.push(`${label} return ${Object.getPrototypeOf(this) === ArrayIteratorPrototype}`);
		return result;
	};
}

const ints = Array.from({ length: 64 }, (_, index) => index);
const rows = Array.from({ length: 6 }, (_, row) =>
	Array.from({ length: 8 }, (_, index) => index + row),
);
const loops = 48;

function warm() {
	let checksum = 0;
	for (let round = 0; round < loops; round++)
		checksum +=
			findAbove(ints, 40 + (round & 7)) + sumUntil(ints, 30) + rowsInnerBreak(rows, 9);
	return checksum;
}

log.push(`intact ${warm()}`);

installReturn("before");
log.push(`find ${findAbove(ints, 40)}`);
log.push(`until ${sumUntil(ints, 30)}`);
log.push(`exhausted ${sumUntil(ints, 1000)}`);
log.push(`rows ${rowsInnerBreak(rows, 9)}`);
delete ArrayIteratorPrototype.return;
log.push(`removed ${findAbove(ints, 40)}`);

// The getter of a trailing hole runs inside the loop and installs the method there.
const trailing = Object.assign(ints.slice(0, 20), { length: 24 });
Object.defineProperty(Array.prototype, 20, {
	get() {
		installReturn("inside");
		return 1000;
	},
	configurable: true,
});
log.push(`inside ${sumUntil(trailing, 30)}`);
log.push(`after inside ${findAbove(ints, 40)}`);
delete Array.prototype[20];
delete ArrayIteratorPrototype.return;

ArrayIteratorPrototype.return = function () {
	throw new Error("close threw");
};
try {
	findAbove(ints, 5);
} catch (error) {
	log.push(error.message);
}
installReturn("primitive", 1);
try {
	sumUntil(ints, 5);
} catch (error) {
	log.push(error.constructor.name);
}
delete ArrayIteratorPrototype.return;

log.push(`restored ${warm()}`);
for (const line of log) console.log(line);
console.log(`loops=${loops}`);
