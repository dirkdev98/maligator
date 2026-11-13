// Hot patterns no direct eval can name: every binding here is private to this module.

function restTotal(base, ...values) {
	let total = base;
	for (const value of values) total += value;
	return total;
}

function capturedEnds(values) {
	const head = () => values[0];
	const tail = () => values[values.length - 1];
	if (!values) return 0;
	return head() + tail();
}

class Meter {
	#count = 0;
	#samples = [];
	record(value) {
		this.#count = this.#count + 1;
		this.#samples.push(value);
		return this.#count;
	}
	sampleTotal() {
		let total = 0;
		for (let index = 0; index < this.#samples.length; index++)
			total += this.#samples[index];
		return total;
	}
}

// Only another module's direct eval reaches this, through a binding it can see.
function triple(value) {
	return value * 3;
}

module.exports = { capturedEnds, Meter, restTotal, triple };
