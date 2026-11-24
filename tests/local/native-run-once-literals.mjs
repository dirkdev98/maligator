let effects = "";
let evaluations = 0;
const input = {
	get first() {
		effects += "a";
		return ++evaluations;
	},
	get second() {
		effects += "b";
		return ++evaluations;
	},
	get broken() {
		effects += "x";
		throw new RangeError("broken");
	},
};

const left = { start: input.first, end: input.second };
const right = { start: input.first, end: input.second };
try {
	console.log({ start: input.broken, end: input.second });
} catch (error) {
	effects += error.message;
}

let checksum = 0;
for (let index = 0; index < 5; index++) {
	const row = { start: input.first, end: input.second };
	checksum += row.start + row.end;
}
console.log(JSON.stringify([left, right, checksum, effects]));
