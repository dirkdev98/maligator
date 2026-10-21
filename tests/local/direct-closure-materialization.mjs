// `reportError` is called directly, but escapes as a value on some paths only.
function check(values, report) {
	const errors = [];
	function reportError(message) {
		errors.push(message);
		return errors.length;
	}
	function forward(value, callback) {
		return callback(`negative ${value}`);
	}
	function visit(value) {
		if (value >= 0) return reportError.length + value * 2;
		return report ? forward(value, reportError) : -1;
	}
	function sameTwice() {
		const first = report ? reportError : undefined;
		const second = report ? reportError : undefined;
		return first === second;
	}
	let sum = 0;
	for (const value of values) sum += visit(value);
	if (values.length > 3) reportError("long");
	return [sum, errors.join(","), sameTwice(), report ? reportError.name : "-"].join(":");
}

const lines = [];
for (let round = 0; round < 3000; round++) {
	const values = [1, round % 5, -(round % 3) - 1, 4];
	lines.push(check(values, round % 4 === 0));
}
console.log(lines.length);
console.log(lines.slice(0, 6).join(" | "));
console.log(lines.slice(-3).join(" | "));
