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
	for (let index = 0; index < 20; index++) data.push(index * 31 + 1);
	let result = 0;
	for (let round = 0; round < 4; round++) result = result + classify(data);
	return result;
}

if (control() !== 15080) throw new Error("small private aggregate memo result");
console.log("private-aggregate-memo-small PASS 1/1");
