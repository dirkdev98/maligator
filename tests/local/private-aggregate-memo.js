function control() {
	function classify(values) {
		let sum = 0;
		let errors = 0;
		for (const value of values) {
			try {
				if (value % 7 === 0) throw "div7";
				sum = sum + (value % 100);
			} catch (error) {
				errors = errors + 1;
			}
		}
		return sum + errors * 1000;
	}
	const data = [];
	for (let index = 0; index < 2000; index++) data.push(index * 31 + 1);
	let result = 0;
	for (let round = 0; round < 1500; round++) {
		result = (result + classify(data)) % 1000000007;
	}
	return result;
}

const first = control();
const second = control();
if (first !== second || first !== 556270500) {
	throw new Error(`private aggregate memo result ${first}/${second}`);
}

// Object elements must never enter the Number-only memo. Their coercion remains
// observable on every ordinary reducer invocation.
let coercions = 0;
function coerce(values) {
	let total = 0;
	for (const value of values) total = total + +value;
	return total;
}
function objectElements() {
	const data = [];
	for (let index = 0; index < 3; index++) {
		data.push({
			valueOf() {
				coercions++;
				return index;
			},
		});
	}
	let total = 0;
	for (let round = 0; round < 4; round++) total = total + coerce(data);
	return total;
}
if (objectElements() !== 12 || coercions !== 12) {
	throw new Error(`object element coercions ${coercions}`);
}

console.log("private-aggregate-memo PASS 2/2");
