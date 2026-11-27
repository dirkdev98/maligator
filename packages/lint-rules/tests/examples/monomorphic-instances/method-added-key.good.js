class Reading {
	value;
	estimated;

	constructor(value) {
		this.value = value;
	}

	markEstimated() {
		this.estimated = true;
	}
}

function readValue(reading) {
	return reading.value;
}

let total = 0;
for (let round = 0; round < 10_000; round++) {
	const reading = new Reading(round);
	if (round & 1) reading.markEstimated();
	total += readValue(reading);
}
console.log(total);
