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

let CurrentReading = Reading;
console.log(total, new CurrentReading(7).value);
CurrentReading = EstimatedReading;
console.log(new CurrentReading(7).value);
