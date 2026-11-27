class Reading {
	value;
	estimated;

	constructor(value, estimated) {
		this.value = value;
		if (estimated) this.estimated = true;
	}
}

function readValue(reading) {
	return reading.value;
}

let total = 0;
for (let round = 0; round < 10_000; round++) {
	total += readValue(new Reading(round, round & 1));
}
console.log(total);
