function countMatches(rows, values) {
	let count = 0;
	for (const [id, adjustment] of rows) {
		let key = id + adjustment;
		if (id < 0) key = adjustment;
		count += values.some((value) => value === id || value === key);
	}
	return count;
}

function indexedMatches(values) {
	let count = 0;
	for (let index = 0, adjustment = 3; index < 7; index++, adjustment += 2) {
		count += values.filter((value) => value === index + adjustment).length;
	}
	return count;
}

const rows = [
	[1, 4],
	[-2, 6],
	[3, 6],
];
console.log("fast", countMatches(rows, [5, 6]), indexedMatches([3, 9, 9, 21]));

const saved = [];
const custom = [];
custom.some = (callback) => {
	saved.push(callback);
	return callback(5);
};
console.log(
	"fallback",
	countMatches(rows, custom),
	JSON.stringify(saved.map((callback) => [callback(1), callback(6), callback(9)])),
);
console.log("fallback identities", saved[0] === saved[1], saved[1] === saved[2]);

let closed = 0;
function* trackedRows() {
	try {
		yield [1, 4];
		yield [-2, 6];
	} finally {
		closed++;
	}
}
const throwing = [];
throwing.some = (callback) => {
	saved.push(callback);
	throw new Error("stop");
};
try {
	countMatches(trackedRows(), throwing);
} catch (error) {
	console.log("abrupt fallback", error.message, closed, saved.at(-1)(5));
}

function escapingClosures(data) {
	const closures = [];
	for (const item of data) {
		closures.push(() => item);
	}
	return closures;
}
const escaping = escapingClosures([7, 8, 9]);
console.log(
	"escaped",
	JSON.stringify(escaping.map((closure) => closure())),
	escaping[0] === escaping[1],
);

function mutationsAfterFallback(data, receiver) {
	for (let item of data) {
		receiver.some((value) => value === item);
		item += 10;
	}
}
const mutable = [];
const saving = [];
saving.some = (callback) => {
	mutable.push(callback);
	return false;
};
mutationsAfterFallback([1, 2], saving);
console.log(
	"late mutation",
	JSON.stringify(mutable.map((callback, index) => callback(index + 11))),
);

function readInTDZ(data) {
	for (const item of data) {
		try {
			data.some((value) => value === later);
		} catch (error) {
			console.log("tdz", item, error.name);
		}
		const later = item;
	}
}
readInTDZ([1, 2]);

function* yieldMatches(data, values) {
	for (const item of data) {
		yield values.map((value) => value + item);
	}
}
console.log("generator", JSON.stringify([...yieldMatches([1, 2], [3, 4])]));
