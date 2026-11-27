class Reading {
	constructor(value) {
		this.value = value;
	}
}

class EstimatedReading {
	constructor(value) {
		this.value = -value;
	}
}

let total = 0;
for (let value = 0; value < 10_000; value++) {
	total += new Reading(value).value;
}

console.log(total, new Reading(7).value);
Reading = EstimatedReading;
console.log(new Reading(7).value);
